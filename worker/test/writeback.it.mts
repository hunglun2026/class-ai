/**
 * 整合測試（v1.18.0）：在 classAI 出作業、分數送回 Classroom 草稿分數、漸進式授權、全班學習診斷。
 * 跟 answer-key-and-attachments.it.mts 一樣用 wrangler getPlatformProxy 的本機 D1/KV，
 * Classroom 與 Gemini 用假回應（看得到送了什麼、可以製造 403/404/額度錯誤）。
 * 跑法：npm run test:it（兩支依序跑，這支用另一組 id，不跟前一支的資料撞）
 */
import { getPlatformProxy } from "wrangler";
import app from "../src/index.ts";

const { env: realEnv, dispose } = await getPlatformProxy<any>({ persist: { path: ".wrangler/state-it/v3" } });
const env: any = realEnv;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      → ${detail}` : ""}`);
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
async function call(method: string, path: string, body?: unknown, sess = "s-wb1") {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `session=${sess}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// ---------- 假的 Classroom 與 Gemini ----------
let courseWorkList: any[] = [];
let createdReply: any = null;
let patchStatus: Record<string, number> = {}; // submissionId → 狀態碼（預設 200）
let tokenResponse: any = {};
const created: any[] = [];
const patches: { url: string; body: any }[] = [];
const listUrls: string[] = [];
let geminiReply: any = null;
let geminiStatus = 200;
const geminiCalls: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const method = init?.method ?? "GET";
  if (url.includes("oauth2.googleapis.com/token")) return Response.json(tokenResponse);
  if (url.includes("classroom.googleapis.com")) {
    if (method === "POST" && /\/courseWork$/.test(url.split("?")[0])) {
      const body = JSON.parse(init.body);
      created.push(body);
      if (createdReply?.status) return new Response("denied", { status: createdReply.status });
      return Response.json({ id: `new-${created.length}`, ...body });
    }
    if (method === "PATCH" && url.includes("/studentSubmissions/")) {
      const subId = url.split("/studentSubmissions/")[1].split("?")[0];
      patches.push({ url, body: JSON.parse(init.body) });
      const st = patchStatus[subId] ?? 200;
      return st === 200 ? Response.json({ id: subId }) : new Response("err", { status: st });
    }
    if (url.includes("/courseWork?")) {
      listUrls.push(url);
      return Response.json({ courseWork: courseWorkList });
    }
    return Response.json({});
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls.push(JSON.parse(init.body));
    if (geminiStatus !== 200) return new Response("RESOURCE_EXHAUSTED", { status: geminiStatus });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReply) }] } }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

// ---------- 種資料（id 都用 wb 開頭） ----------
const now = Math.floor(Date.now() / 1000);
await env.DB.batch([
  env.DB.prepare("INSERT INTO teachers VALUES ('wbt1','wb1@x.tw','寫回老師',NULL,'x','fake-token',?,?,?)").bind(now + 3000, now, now),
  env.DB.prepare("INSERT INTO teachers VALUES ('wbt2','wb2@x.tw','別班老師',NULL,'x','fake-token',?,?,?)").bind(now + 3000, now, now),
  env.DB.prepare("INSERT INTO courses VALUES ('wbc1','wbt1','國語','六甲',?)").bind(now),
  env.DB.prepare("INSERT INTO course_teachers VALUES ('wbc1','wbt1',?)").bind(now),
  env.DB.prepare("INSERT INTO courses VALUES ('wbc2','wbt2','數學','五乙',?)").bind(now),
  env.DB.prepare("INSERT INTO course_teachers VALUES ('wbc2','wbt2',?)").bind(now),
]);
await env.SESSIONS.put("session:s-wb1", "wbt1");
await env.SESSIONS.put("session:s-wb2", "wbt2");
const setWrite = (v: 0 | 1, t = "wbt1") =>
  env.DB.prepare(
    "INSERT INTO teacher_write_access VALUES (?, ?, ?) ON CONFLICT(teacher_id) DO UPDATE SET can_write = excluded.can_write"
  )
    .bind(t, v, now)
    .run();
const taipei = (offsetDays: number, hhmm: string) => {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000);
  return { date: d.toISOString().slice(0, 10), time: hhmm };
};

console.log("\n== 十一、漸進式授權（寫入權限） ==");
{
  const login = await app.fetch(new Request("http://localhost/api/auth/google/login"), env, ctx);
  const up = await app.fetch(new Request("http://localhost/api/auth/google/upgrade?return=%2Fcourses%2Fwbc1"), env, ctx);
  const lUrl = new URL(login.headers.get("Location") ?? "http://x");
  const uUrl = new URL(up.headers.get("Location") ?? "http://x");
  const WRITE = "https://www.googleapis.com/auth/classroom.coursework.students";
  const lScopes = (lUrl.searchParams.get("scope") ?? "").split(" ");
  const uScopes = (uUrl.searchParams.get("scope") ?? "").split(" ");
  check("11-1 一般登入不要寫入權限、帶 include_granted_scopes", !lScopes.includes(WRITE) && lUrl.searchParams.get("include_granted_scopes") === "true", lScopes.join(" "));
  check("11-2 升級登入多要 classroom.coursework.students", uScopes.includes(WRITE) && uScopes.length === lScopes.length + 1, uScopes.join(" "));

  const cb = async (state: string, scope: string, sub: string) => {
    tokenResponse = {
      access_token: "a", refresh_token: "rt", expires_in: 3600, scope,
      id_token: "x." + Buffer.from(JSON.stringify({ sub, email: `${sub}@x.tw`, name: "升級老師" })).toString("base64url") + ".y",
    };
    const res = await app.fetch(
      new Request(`http://localhost/api/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { Cookie: `oauth_state=${state}` } }),
      env,
      ctx
    );
    return res.headers.get("Location") ?? "";
  };
  const BASE = "openid email profile https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.students.readonly https://www.googleapis.com/auth/classroom.rosters.readonly https://www.googleapis.com/auth/drive.readonly";
  const back = Buffer.from("/courses/wbc1").toString("base64url");
  let loc = await cb(`abc.w.${back}`, `${BASE} https://www.googleapis.com/auth/classroom.coursework.students`, "up-t1");
  let row: any = await env.DB.prepare("SELECT can_write FROM teacher_write_access WHERE teacher_id = 'up-t1'").first();
  check("11-3 同意寫入：記 can_write=1、回到原本那頁", row?.can_write === 1 && loc.endsWith("/courses/wbc1"), `${loc} ${JSON.stringify(row)}`);
  loc = await cb(`abd.w.${back}`, BASE, "up-t2");
  row = await env.DB.prepare("SELECT can_write FROM teacher_write_access WHERE teacher_id = 'up-t2'").first();
  check("11-4 沒勾寫入：can_write=0、帶 write=denied 回原頁", row?.can_write === 0 && loc.endsWith("/courses/wbc1?write=denied"), loc);
  const evil = Buffer.from("//evil.example").toString("base64url");
  loc = await cb(`abe.r.${evil}`, BASE, "up-t3");
  check("11-5 回到的網址是 //外站：不理，回首頁", !loc.includes("evil") && loc.endsWith("/"), loc);
  loc = await cb("abf.r.", `${BASE} https://www.googleapis.com/auth/classroom.coursework.students`, "up-t1");
  row = await env.DB.prepare("SELECT can_write FROM teacher_write_access WHERE teacher_id = 'up-t1'").first();
  check("11-6 之後一般登入，Google 帶回之前給過的寫入權限：維持 can_write=1", row?.can_write === 1, JSON.stringify(row));
  loc = await cb("abg.r.", BASE, "up-t1");
  row = await env.DB.prepare("SELECT can_write FROM teacher_write_access WHERE teacher_id = 'up-t1'").first();
  check("11-7 老師到 Google 撤銷寫入後再登入：can_write 跟著變 0", row?.can_write === 0, JSON.stringify(row));

  const me0 = await call("GET", "/api/auth/me");
  await setWrite(1);
  const me1 = await call("GET", "/api/auth/me");
  check("11-8 /me 回報 canWrite", me0.json?.teacher?.canWrite === false && me1.json?.teacher?.canWrite === true, `${me0.text} ${me1.text}`);
  await setWrite(0);
}

console.log("\n== 十二、在 classAI 出作業 ==");
{
  let r = await call("POST", "/api/courses/wbc1/coursework", { title: "讀書心得", maxPoints: 20, publish: true });
  check("12-1 沒有寫入權限：403 need_write_scope、沒打 Classroom", r.status === 403 && r.json?.code === "need_write_scope" && created.length === 0, r.text);
  await setWrite(1);
  r = await call("POST", "/api/courses/wbc1/coursework", { title: "  ", maxPoints: 20, publish: true });
  check("12-2 標題空白：400 白話錯誤", r.status === 400 && r.json?.error === "請填作業標題", r.text);
  r = await call("POST", "/api/courses/wbc1/coursework", { title: "x", maxPoints: 0, publish: true });
  check("12-3 滿分 0：400", r.status === 400, r.text);
  r = await call("POST", "/api/courses/wbc1/coursework", { title: "x", maxPoints: 10, publish: true, due: taipei(-1, "08:00") });
  check("12-4 截止時間已過：400", r.status === 400 && r.json?.error?.includes("已經過了"), r.text);
  r = await call("POST", "/api/courses/wbc2/coursework", { title: "x", maxPoints: 10, publish: true });
  check("12-5 別人的課：404", r.status === 404, r.text);

  const due = taipei(3, "07:30");
  r = await call("POST", "/api/courses/wbc1/coursework", { title: "讀書心得", description: "寫 300 字", maxPoints: 20, publish: false, due });
  const sent = created.at(-1);
  const expUtc = new Date(`${due.date}T07:30:00+08:00`);
  check(
    "12-6 建立：ASSIGNMENT、草稿、截止時間換成 UTC（台灣 07:30＝前一天 23:30 UTC）",
    r.status === 200 && sent?.workType === "ASSIGNMENT" && sent?.state === "DRAFT" && sent?.maxPoints === 20 &&
      sent?.dueDate?.day === expUtc.getUTCDate() && sent?.dueTime?.hours === 23 && sent?.dueTime?.minutes === 30,
    JSON.stringify(sent)
  );
  const newId = r.json?.courseWork?.id;
  const cw: any = await env.DB.prepare("SELECT title, max_points FROM coursework WHERE id = ?").bind(newId).first();
  const wb: any = await env.DB.prepare("SELECT can_write_back, created_by_classai_at FROM coursework_writeback WHERE coursework_id = ?").bind(newId).first();
  const watch: any = await env.DB.prepare("SELECT teacher_id FROM autograde_watch WHERE coursework_id = ?").bind(newId).first();
  check("12-7 存進 D1、標可寫回、登記背景自動預批", cw?.title === "讀書心得" && wb?.can_write_back === 1 && !!wb?.created_by_classai_at && watch?.teacher_id === "wbt1", JSON.stringify({ cw, wb, watch }));
  r = await call("POST", "/api/courses/wbc1/coursework", { title: "發布版", maxPoints: 10, publish: true });
  check("12-8 選直接發布：state=PUBLISHED、沒給截止日就不帶", created.at(-1)?.state === "PUBLISHED" && !created.at(-1)?.dueDate, JSON.stringify(created.at(-1)));

  createdReply = { status: 403 };
  r = await call("POST", "/api/courses/wbc1/coursework", { title: "權限被撤", maxPoints: 10, publish: true });
  check("12-9 Google 回 403（權限被撤）：回 need_write_scope 讓老師重新允許", r.status === 403 && r.json?.code === "need_write_scope", r.text);
  createdReply = null;
}

console.log("\n== 十三、作業清單：誰能寫回 ==");
{
  courseWorkList = [
    { id: "wbw-mine", title: "classAI 出的", state: "PUBLISHED", maxPoints: 10, associatedWithDeveloper: true },
    { id: "wbw-cr", title: "Classroom 手建", state: "PUBLISHED", maxPoints: 10 },
    { id: "wbw-draft-mine", title: "classAI 草稿", state: "DRAFT", maxPoints: 10, associatedWithDeveloper: true },
    { id: "wbw-draft-cr", title: "老師自己的草稿", state: "DRAFT", maxPoints: 10 },
  ];
  await setWrite(0);
  listUrls.length = 0;
  let r = await call("GET", "/api/courses/wbc1/coursework");
  check("13-1 沒寫入權限：只查已發布（行為跟以前一樣）", listUrls.length === 1 && !listUrls[0].includes("DRAFT") && r.json?.canWrite === false, listUrls.join(" "));
  await setWrite(1);
  listUrls.length = 0;
  r = await call("GET", "/api/courses/wbc1/coursework");
  const ids = (r.json?.courseWork ?? []).map((w: any) => w.id);
  check("13-2 有寫入權限：一起查草稿，但只列 classAI 自己的草稿", listUrls[0]?.includes("DRAFT") && ids.includes("wbw-draft-mine") && !ids.includes("wbw-draft-cr"), ids.join(","));
  const flags: any = await env.DB.prepare(
    "SELECT coursework_id id, can_write_back v FROM coursework_writeback WHERE coursework_id IN ('wbw-mine','wbw-cr') ORDER BY coursework_id"
  ).all();
  const m = Object.fromEntries(flags.results.map((x: any) => [x.id, x.v]));
  check("13-3 依 associatedWithDeveloper 記可否寫回", m["wbw-mine"] === 1 && m["wbw-cr"] === 0, JSON.stringify(m));
}

console.log("\n== 十四、分數送回 Classroom ==");
const addSub = async (cwId: string, id: string, name: string, g?: { ai: number | null; final?: number | null; status?: string; locked?: number; fb?: string }) => {
  await env.DB.prepare(
    "INSERT INTO submissions (id, coursework_id, student_id, student_name, state, content_text, attachments_json, fetched_at) VALUES (?, ?, ?, ?, 'TURNED_IN', '', '[]', ?)"
  ).bind(id, cwId, `u-${id}`, name, now).run();
  if (g) {
    await env.DB.prepare(
      "INSERT INTO grades (id, submission_id, ai_score, ai_feedback, final_score, final_feedback, status, graded_at, updated_at, locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(`g-${id}`, id, g.ai, g.fb ?? "AI 評語", g.final ?? null, g.final === undefined ? null : g.fb ?? "老師評語", g.status ?? "ai_suggested", now, now, g.locked ?? 0).run();
  }
};
{
  await addSub("wbw-cr", "wb-cr-1", "甲", { ai: 8, final: 8, status: "confirmed" });
  let r = await call("POST", "/api/submissions/wbw-cr/push-grades");
  check("14-1 Classroom 手建的作業：409 not_classai_work、白話說明、沒打 Classroom", r.status === 409 && r.json?.code === "not_classai_work" && r.json?.error?.includes("在 classAI 出作業") && patches.length === 0, r.text);

  await addSub("wbw-mine", "wb-a", "王小明", { ai: 7, final: 8, status: "confirmed" });
  await addSub("wbw-mine", "wb-b", "李小華", { ai: 6 }); // 只是 AI 建議
  await addSub("wbw-mine", "wb-c", "張小美", { ai: 4, final: 5, status: "teacher_edited", locked: 1 });
  await addSub("wbw-mine", "wb-d", "陳大同", { ai: 9, status: "confirmed" }); // 老師直接確認、沒改分
  await addSub("wbw-mine", "wb-e", "林未批"); // 還沒評

  await setWrite(0);
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  check("14-2 老師沒給寫入權限：403 need_write_scope", r.status === 403 && r.json?.code === "need_write_scope", r.text);
  await setWrite(1);

  patches.length = 0;
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  const sent = Object.fromEntries(patches.map((p) => [p.url.split("/studentSubmissions/")[1].split("?")[0], p.body.draftGrade]));
  check(
    "14-3 只送已確認／已鎖定的：王 8、張 5、陳 9（沒改分就送 AI 分），李（只是 AI 建議）不送",
    r.status === 200 && r.json?.pushed === 3 && sent["wb-a"] === 8 && sent["wb-c"] === 5 && sent["wb-d"] === 9 && !("wb-b" in sent) && r.json?.notConfirmed === 2,
    `${r.text} ${JSON.stringify(sent)}`
  );
  check("14-4 寫的是 draftGrade（草稿分數），不是 assignedGrade", patches.every((p) => p.url.includes("updateMask=draftGrade") && !("assignedGrade" in p.body)), patches.map((p) => p.url).join(" "));

  patches.length = 0;
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  check("14-5 再按一次、分數都沒變：一個都不重送", r.json?.pushed === 0 && patches.length === 0, r.text);

  await call("PATCH", "/api/submissions/wb-a/grade", { finalScore: 9, finalFeedback: "改成 9 分", confirm: true });
  let list = await call("GET", "/api/submissions/wbw-mine");
  const a = list.json?.submissions?.find((s: any) => s.id === "wb-a");
  check("14-6 送出後老師又改分：清單看得出 Classroom 上還是舊分數（pushed 8、現在 9）", a?.pushed_score === 8 && a?.final_score === 9 && list.json?.canWriteBack === true && list.json?.canWrite === true, JSON.stringify(a));
  patches.length = 0;
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  check("14-7 再送：只送改過的王小明 9 分", r.json?.pushed === 1 && patches.length === 1 && patches[0].body.draftGrade === 9, JSON.stringify(patches));

  await env.DB.prepare("UPDATE grades SET final_score = 10, status = 'confirmed' WHERE submission_id IN ('wb-c','wb-d')").run();
  patchStatus = { "wb-c": 404 };
  patches.length = 0;
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  check(
    "14-8 有一位在 Classroom 找不到：其他照送，失敗的寫出名字與原因",
    r.json?.pushed === 1 && r.json?.failed?.length === 1 && r.json.failed[0].name === "張小美" && r.json.failed[0].reason.includes("找不到"),
    r.text
  );

  patchStatus = { "wb-c": 403 };
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  const cw: any = await env.DB.prepare("SELECT can_write FROM teacher_write_access WHERE teacher_id = 'wbt1'").first();
  check("14-9 Google 回 403（權限被撤）：回 need_write_scope 並把 can_write 改回 0", r.status === 403 && r.json?.code === "need_write_scope" && cw?.can_write === 0, r.text);
  patchStatus = {};
  await setWrite(1);

  patchStatus = { "wb-c": 401 };
  r = await call("POST", "/api/submissions/wbw-mine/push-grades");
  check("14-9b Google 授權過期（401）：回 auth_expired 讓前端請老師重新登入，不是逐位報失敗", r.status === 401 && r.json?.code === "auth_expired", r.text);
  patchStatus = {};

  r = await call("POST", "/api/submissions/wbw-mine/push-grades", undefined, "s-wb2");
  check("14-10 別班老師：404，不能送別人班的分數", r.status === 404, r.text);

  // 大班：45 位，一次最多送 40，剩下的前端接著送
  await env.DB.prepare("INSERT INTO coursework VALUES ('wbw-big','wbc1','大班',NULL,10,?)").bind(now).run();
  await env.DB.prepare("INSERT INTO coursework_writeback VALUES ('wbw-big',1,?,?)").bind(now, now).run();
  for (let i = 0; i < 45; i++) await addSub("wbw-big", `wb-big-${i}`, `學生${i}`, { ai: 5, status: "confirmed" });
  patches.length = 0;
  const r1 = await call("POST", "/api/submissions/wbw-big/push-grades");
  const r2 = await call("POST", "/api/submissions/wbw-big/push-grades");
  check("14-11 45 位：第一次送 40、剩 5；第二次送完 5、剩 0", r1.json?.pushed === 40 && r1.json?.remaining === 5 && r2.json?.pushed === 5 && r2.json?.remaining === 0, `${r1.text} ${r2.text}`);
}

console.log("\n== 十五、全班學習診斷 ==");
{
  await env.DB.prepare("INSERT INTO coursework VALUES ('wbw-ins','wbc1','閱讀測驗',NULL,10,?)").bind(now).run();
  for (let i = 1; i <= 4; i++) await addSub("wbw-ins", `wb-i${i}`, `學生名${i}`, { ai: i + 4, fb: `評語${i}：主旨抓錯` });
  let r = await call("POST", "/api/submissions/wbw-ins/insights");
  check("15-1 只批了 4 位：400 說明至少要 5 位、沒叫 AI", r.status === 400 && r.json?.error?.includes("5 位") && geminiCalls.length === 0, r.text);

  await addSub("wbw-ins", "wb-i5", "學生名5", { ai: 3, fb: "評語5：沒寫結論" });
  geminiReply = {
    summary: "多數同學讀懂內容",
    strengths: "字詞理解好",
    issues: [
      { title: "主旨抓錯", detail: "把細節當主旨", studentCodes: ["S1", "S2", "S3", "S99"], suggestion: "下次先畫段落重點" },
      { title: "只有一個亂編的", detail: "x", studentCodes: ["S77"], suggestion: "x" },
    ],
  };
  const before: any = await env.DB.prepare("SELECT used FROM ai_usage WHERE teacher_id = 'wbt1'").first();
  r = await call("POST", "/api/submissions/wbw-ins/insights");
  const prompt = JSON.stringify(geminiCalls.at(-1));
  const issue = r.json?.insights?.issues?.[0];
  check("15-2 叫 AI 一次、送出的內容沒有學生姓名（只用 S1…）", r.status === 200 && geminiCalls.length === 1 && !prompt.includes("學生名") && prompt.includes("S5"), prompt.slice(0, 300));
  check("15-3 代號換回姓名、AI 亂編的代號丟掉、全是亂編的問題整條不顯示", issue?.students?.length === 3 && issue.students.includes("學生名1") && r.json.insights.issues.length === 1, JSON.stringify(r.json?.insights));
  const after: any = await env.DB.prepare("SELECT used FROM ai_usage WHERE teacher_id = 'wbt1'").first();
  check("15-4 算進老師每日 AI 次數", (after?.used ?? 0) === (before?.used ?? 0) + 1, `${before?.used}→${after?.used}`);

  r = await call("POST", "/api/submissions/wbw-ins/insights");
  check("15-5 全班沒變再按：用快取、不叫 AI", r.json?.cached === true && geminiCalls.length === 1, r.text);
  let g = await call("GET", "/api/submissions/wbw-ins/insights");
  check("15-6 GET 只讀快取、不過期", g.json?.insights?.summary === "多數同學讀懂內容" && g.json?.stale === false && geminiCalls.length === 1, g.text);

  await env.DB.prepare("UPDATE grades SET final_score = 9, final_feedback = '老師改了' WHERE submission_id = 'wb-i1'").run();
  g = await call("GET", "/api/submissions/wbw-ins/insights");
  check("15-7 老師改了分數或評語：GET 標 stale（提示可以重新整理）", g.json?.stale === true, g.text);

  geminiStatus = 429;
  r = await call("POST", "/api/submissions/wbw-ins/insights");
  check("15-8 AI 額度滿：502 白話說明，不記次數", r.status === 502 && r.json?.error?.includes("使用量"), r.text);
  geminiStatus = 200;

  const r3 = await call("GET", "/api/submissions/wbw-ins/insights", undefined, "s-wb2");
  check("15-9 別班老師看不到：404", r3.status === 404, r3.text);
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
await dispose();
process.exit(fail ? 1 : 0);
