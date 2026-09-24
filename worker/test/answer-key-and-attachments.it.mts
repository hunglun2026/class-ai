/**
 * 整合測試：標準答案檔存 R2、學生附件大小上限（v1.6.1）、老師手動打分與防呆（v1.7.0）、全 App 防呆（v1.8.0）、協同教學（v1.9.0）、同網域與來源檢查（v1.10.0）、AI 用量上限（v1.11.0）。
 *
 * 用 wrangler getPlatformProxy 拿本機真的 D1/R2/KV，直接呼叫 Worker 的 app.fetch；
 * Google Drive 與 Gemini 用假回應（可任意製造大檔、壞檔，也能檢查到底送了什麼給 AI）。
 *
 * 跑法（在 worker/ 底下）：npm run test:it
 *   加 REAL_GEMINI=1 且給 REAL_AK_PDF／REAL_STU_RIGHT／REAL_STU_WRONG 三個檔案路徑，
 *   最後會真的打 Gemini 各評一次（會用到額度）。
 * 資料放 .wrangler/state-it，每次跑之前由 npm script 清空重建。
 */
import { readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { zipSync, strToU8 } from "fflate";
import app from "../src/index.ts";

const MB = 1024 * 1024;
const { env: realEnv, dispose } = await getPlatformProxy<any>({ persist: { path: ".wrangler/state-it/v3" } });
const env: any = realEnv;

// ---------- 小工具 ----------
let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      → ${detail}` : ""}`);
}
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");
const bytes = (n: number, seed = 7) => {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i += 4096) u[i] = (i / 4096 + seed) & 255;
  return u;
};
async function call(method: string, path: string, body?: unknown, sess = "s-t1", e: any = env) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `session=${sess}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
    { waitUntil() {}, passThroughOnException() {} } as any
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
async function r2Keys(): Promise<string[]> {
  const l = await env.ATTACHMENTS.list({ prefix: "answer-keys/" });
  return l.objects.map((o: any) => o.key);
}
async function rubricRow(cw = "w1") {
  return env.DB.prepare(
    "SELECT answer_key_file_name n, answer_key_file_mime m, answer_key_file_r2_key k, answer_key_file_base64 b, answer_key_file_extracted_text x FROM rubrics WHERE coursework_id = ?"
  )
    .bind(cw)
    .first();
}

// ---------- 假的 Google Drive 與 Gemini ----------
type FakeFile = { mime: string; size?: number; actual: number | Uint8Array; status?: number; text?: string };
const driveFiles: Record<string, FakeFile> = {};
const downloads: Record<string, number> = {};
let geminiMode: "fake" | "real" = "fake";
let classroomStatus = 200;
let geminiFails = false;
let classroomSubs: any[] | null = null;
let classroomCourses: any[] = [{ id: "c1", name: "自然", section: "A", courseState: "ACTIVE" }];
let tokenResponse: any = {};
let geminiCalls: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const m = url.match(/googleapis\.com\/drive\/v3\/files\/([^/?]+)(\/export)?/);
  if (m) {
    const f = driveFiles[m[1]];
    if (!f || f.status) return new Response("no", { status: f?.status ?? 404 });
    if (m[2]) return new Response(f.text ?? "");
    if (url.includes("alt=media")) {
      downloads[m[1]] = (downloads[m[1]] ?? 0) + 1;
      return new Response(typeof f.actual === "number" ? bytes(f.actual) : f.actual);
    }
    return Response.json({ id: m[1], name: `${m[1]}.bin`, mimeType: f.mime, ...(f.size != null ? { size: String(f.size) } : {}) });
  }
  if (url.includes("oauth2.googleapis.com/token")) {
    return Response.json(tokenResponse);
  }
  if (url.includes("classroom.googleapis.com")) {
    if (classroomStatus !== 200) return new Response("denied", { status: classroomStatus });
    if (url.includes("/courses?") || url.match(/\/courses\?/)) return Response.json({ courses: classroomCourses });
    if (url.includes("/studentSubmissions") && classroomSubs) return Response.json({ studentSubmissions: classroomSubs });
    if (url.includes("/studentSubmissions")) {
      return Response.json({
        studentSubmissions: [
          {
            id: "cr1", userId: "cu1", state: "TURNED_IN",
            assignmentSubmission: { attachments: [
              { driveFile: { id: "df1", title: "報告.pdf", alternateLink: "https://drive.google.com/file/d/df1/view?usp=drive_web" } },
              { link: { url: "https://www.canva.com/design/abc", title: "我的海報" } },
            ] },
          },
        ],
      });
    }
    if (url.includes("/students")) return Response.json({ students: [{ userId: "cu1", profile: { name: { fullName: "陳同步" } } }] });
    return Response.json({});
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls.push(JSON.parse(init.body));
    if (geminiMode === "real") return realFetch(input, init);
    if (geminiFails) return new Response("boom", { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 7, feedback: "假評語" }) }] } }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

// 送給 Gemini 的內容裡有哪些 inline 檔案（依大小辨識）與文字
function sentInline(call: any): number[] {
  return call.contents[0].parts.filter((p: any) => p.inline_data).map((p: any) => Buffer.from(p.inline_data.data, "base64").length);
}
function sentText(call: any): string {
  return call.contents[0].parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n");
}

// ---------- 種測試資料 ----------
const now = Math.floor(Date.now() / 1000);
await env.DB.batch([
  env.DB.prepare("INSERT INTO teachers VALUES ('t1','t1@x.tw','老師一',NULL,'x','fake-token',?,?,?)").bind(now + 3000, now, now),
  env.DB.prepare("INSERT INTO teachers VALUES ('t2','t2@x.tw','老師二',NULL,'x','fake-token',?,?,?)").bind(now + 3000, now, now),
  env.DB.prepare("INSERT INTO courses VALUES ('c1','t1','自然','A',?)").bind(now),
  env.DB.prepare("INSERT INTO courses VALUES ('c2','t2','數學','B',?)").bind(now),
  env.DB.prepare("INSERT INTO course_teachers VALUES ('c1','t1',?)").bind(now),
  env.DB.prepare("INSERT INTO course_teachers VALUES ('c2','t2',?)").bind(now),
  env.DB.prepare("INSERT INTO coursework VALUES ('w1','c1','四季測驗',NULL,10,?)").bind(now),
  env.DB.prepare("INSERT INTO coursework VALUES ('w2','c2','別班作業',NULL,10,?)").bind(now),
]);
await env.SESSIONS.put("session:s-t1", "t1");
await env.SESSIONS.put("session:s-t2", "t2");
let subSeq = 0;
async function newSubmission(text: string, fileIds: string[], links: string[] = []): Promise<string> {
  const id = `sub${++subSeq}`;
  const att = [
    ...fileIds.map((f) => ({ type: "doc", driveFileId: f, name: f })),
    ...links.map((u) => ({ type: "link", name: u, url: u })),
  ];
  await env.DB.prepare(
    "INSERT INTO submissions (id, coursework_id, student_id, student_name, state, content_text, attachments_json, fetched_at) VALUES (?, 'w1', ?, '學生', 'TURNED_IN', ?, ?, ?)"
  )
    .bind(id, `u${subSeq}`, text, JSON.stringify(att), now)
    .run();
  return id;
}
const pdfFile = (name: string, n: number) => ({ name, mimeType: "application/pdf", base64: b64(bytes(n)) });
const rubricBody = (extra: object = {}) => ({ courseWorkId: "w1", mode: "answer_key", answerKey: "", maxPoints: 10, ...extra });

console.log("\n== 一、答案檔儲存（rubrics） ==");
{
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("a.pdf", 3.6 * MB) }));
  const row: any = await rubricRow();
  const keys = await r2Keys();
  check("1-1 上傳 3.6MB PDF 成功", r.status === 200, r.text);
  check("1-2 D1 只記位置、base64 欄位是空的", !!row.k && row.b === null, JSON.stringify(row).slice(0, 200));
  const obj = await env.ATTACHMENTS.get(row.k);
  const got = new Uint8Array(await obj.arrayBuffer());
  check("1-3 R2 內容跟上傳的一樣", got.length === Math.floor(3.6 * MB) && b64(got) === b64(bytes(3.6 * MB)));
  check("1-4 R2 的 contentType 是 application/pdf", obj.httpMetadata?.contentType === "application/pdf");
  check("1-5 R2 只有一個檔", keys.length === 1, keys.join(","));
}
{
  const before: any = await rubricRow();
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKey: "只改文字" }));
  const after: any = await rubricRow();
  check("1-6 只改文字不動檔案：r2_key 不變、R2 檔還在", r.status === 200 && after.k === before.k && (await r2Keys()).length === 1);
}
{
  const before: any = await rubricRow();
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: { name: "b.png", mimeType: "image/png", base64: b64(bytes(2 * MB, 9)) } }));
  const after: any = await rubricRow();
  const keys = await r2Keys();
  check("1-7 換成圖片：新 key、舊檔刪掉、R2 還是只有一個", r.status === 200 && after.k !== before.k && keys.length === 1 && keys[0] === after.k, keys.join(","));
  check("1-8 換檔後 mime 與檔名更新", after.m === "image/png" && after.n === "b.png");
}
{
  // 真的 xlsx：用 SheetJS 產一份
  const XLSX = await import("@e965/xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["題號", "答案"], [1, "B"]]), "答案");
  const xlsx = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: { name: "k.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: xlsx } }));
  const row: any = await rubricRow();
  check("1-9 換成 Excel：存成文字、r2_key 清空、R2 舊圖刪掉", r.status === 200 && row.k === null && (row.x ?? "").includes("B") && (await r2Keys()).length === 0, JSON.stringify(row).slice(0, 200));
}
{
  await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("c.pdf", MB) }));
  const r = await call("POST", "/api/rubrics", rubricBody({ removeAnswerKeyFile: true }));
  const row: any = await rubricRow();
  check("1-10 移除答案檔：欄位全空、R2 清空", r.status === 200 && row.k === null && row.n === null && row.b === null && (await r2Keys()).length === 0);
}
{
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("big.pdf", 8 * MB + 10) }));
  check("1-11 超過 8MB 回 413、R2 沒有多東西", r.status === 413 && (await r2Keys()).length === 0, `${r.status} ${r.text}`);
  const ok = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("max.pdf", 8 * MB - 1000) }));
  check("1-12 剛好 8MB 以內可以存", ok.status === 200 && (await r2Keys()).length === 1, ok.text);
}
{
  const before = await r2Keys();
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("x.pdf", MB) }), "s-t2");
  check("1-13 別的老師改我的作業：404、R2 沒被寫入", r.status === 404 && (await r2Keys()).length === before.length);
  const r2 = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("x.pdf", MB) }), "nobody");
  check("1-14 沒登入：401", r2.status === 401);
}
{
  // 資料庫寫入失敗：剛放進 R2 的檔要被刪掉，不留孤兒
  const before = await r2Keys();
  const failingDb = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare")
        return (sql: string) => {
          if (sql.includes("INSERT INTO rubrics")) return { bind: () => ({ first: async () => { throw new Error("模擬 D1 故障"); } }) };
          return t.prepare(sql);
        };
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("y.pdf", MB) }), "s-t1", { ...env, DB: failingDb });
  const after = await r2Keys();
  check("1-15 D1 寫入失敗：回 500、新檔已從 R2 刪掉、舊檔還在", r.status === 500 && after.length === before.length && after[0] === before[0], `${r.status} ${after}`);
  check("1-16 D1 失敗的錯誤訊息不外洩內部細節", !r.text.includes("模擬 D1 故障"), r.text);
}
{
  const before = await r2Keys();
  const r = await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: { name: "z.exe", mimeType: "application/x-msdownload", base64: "AAAA" } }));
  check("1-17 不允許的檔案類型：回 400（不是 500）、R2 沒被寫入", r.status === 400 && (await r2Keys()).length === before.length, `${r.status}`);
  const bad = await call("POST", "/api/rubrics", { mode: "answer_key" });
  check("1-18 缺必要欄位：回 400、訊息不外洩驗證細節", bad.status === 400 && !bad.text.includes("invalid_type"), `${bad.status} ${bad.text}`);
}

console.log("\n== 二、AI 評分讀答案檔與學生附件（ai-grade） ==");
const AK = (await rubricRow() as any).k as string; // 目前的答案檔：max.pdf（8MB - 1000）
const AK_SIZE = 8 * MB - 1000;
{
  geminiCalls = [];
  const s = await newSubmission("第1題：B", []);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-1 答案檔從 R2 讀出來送給 AI", r.status === 200 && geminiCalls.length === 1 && sentInline(geminiCalls[0]).includes(AK_SIZE), `${r.status} ${JSON.stringify(sentInline(geminiCalls[0] ?? { contents: [{ parts: [] }] }))}`);
  check("2-2 沒有太大的附件就沒有多餘警示", !(r.json?.confidenceFlags ?? []).some((f: string) => f.includes("太大")));
}
{
  // 預算：20MB - 答案檔 8MB = 12MB。a10 放得下，剩約 2MB；b5 太大跳過；c1 放得下
  driveFiles.a10 = { mime: "image/jpeg", size: 10 * MB, actual: 10 * MB };
  driveFiles.b5 = { mime: "image/jpeg", size: 5 * MB, actual: 5 * MB };
  driveFiles.c1 = { mime: "application/pdf", size: 1 * MB, actual: 1 * MB };
  geminiCalls = [];
  const s = await newSubmission("", ["a10", "b5", "c1"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  const sent = sentInline(geminiCalls[0]);
  check("2-3 額度內的檔案都送出（答案檔＋10MB＋1MB）", r.status === 200 && sent.includes(AK_SIZE) && sent.includes(10 * MB) && sent.includes(1 * MB), JSON.stringify(sent));
  check("2-4 超過剩餘額度的 5MB 沒送、也沒下載", !sent.includes(5 * MB) && !downloads.b5, `downloads=${downloads.b5}`);
  const flags: string[] = r.json?.confidenceFlags ?? [];
  check("2-5 回應裡有「1 個附件太大」警示並點名檔案", flags.some((f) => f.includes("1 個附件太大") && f.includes("b5.bin")), JSON.stringify(flags));
  const g: any = await env.DB.prepare("SELECT confidence_flags FROM grades WHERE submission_id = ?").bind(s).first();
  check("2-6 警示有存進資料庫（重新整理頁面還看得到）", (g?.confidence_flags ?? "").includes("太大"));
}
{
  driveFiles.p16 = { mime: "application/pdf", size: 16 * MB, actual: 16 * MB };
  geminiCalls = [];
  const s = await newSubmission("", ["p16"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-7 只交一個超過 15MB 的檔：422、不叫 AI、不下載", r.status === 422 && geminiCalls.length === 0 && !downloads.p16, `${r.status} ${r.text}`);
  check("2-8 錯誤訊息講清楚是「太大」", (r.json?.error ?? "").includes("太大"), r.json?.error);
}
{
  driveFiles.nosize = { mime: "image/png", actual: 17 * MB }; // Drive 沒回 size
  geminiCalls = [];
  const s = await newSubmission("有寫文字", ["nosize"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-9 沒回 size 的 17MB 檔：下載後擋下、有文字所以照評並警示", r.status === 200 && downloads.nosize === 1 && !sentInline(geminiCalls[0]).includes(17 * MB) && (r.json?.confidenceFlags ?? []).some((f: string) => f.includes("太大")), `${r.status}`);
}
{
  driveFiles.denied = { mime: "", actual: 0, status: 403 };
  driveFiles.p16b = { mime: "application/pdf", size: 16 * MB, actual: 16 * MB };
  geminiCalls = [];
  const s = await newSubmission("", ["p16b", "denied"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-10 太大＋沒權限混合、沒有文字：422、不叫 AI、訊息講讀不到", r.status === 422 && geminiCalls.length === 0 && (r.json?.error ?? "").includes("讀不到"), `${r.status} ${r.text}`);
}
{
  geminiCalls = [];
  const s = await newSubmission("", []);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-10a 按了繳交但空白：422、不叫 AI", r.status === 422 && geminiCalls.length === 0 && (r.json?.error ?? "").includes("沒有寫任何內容"), `${r.status} ${r.text}`);
}
{
  geminiCalls = [];
  const s = await newSubmission("", [], ["https://www.canva.com/design/xxx"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-10b 只交連結：422、不叫 AI", r.status === 422 && geminiCalls.length === 0 && (r.json?.error ?? "").includes("連結"), `${r.status} ${r.text}`);
}
{
  driveFiles.sheet = { mime: "application/vnd.google-apps.spreadsheet", actual: 0 };
  geminiCalls = [];
  const s = await newSubmission("我的心得在試算表裡，重點是地軸傾斜", ["sheet"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-10c 有文字＋試算表附件：照評、警示「1 個附件 AI 讀不到」", r.status === 200 && geminiCalls.length === 1 && (r.json?.confidenceFlags ?? []).some((f: string) => f.includes("1 個附件 AI 讀不到")), `${r.status} ${JSON.stringify(r.json?.confidenceFlags)}`);
}
{
  driveFiles.emptydoc = { mime: "application/vnd.google-apps.document", actual: 0, text: "  \n " };
  geminiCalls = [];
  const s = await newSubmission("", ["emptydoc"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-10d 只交一份空白 Google 文件：422、不叫 AI", r.status === 422 && geminiCalls.length === 0, `${r.status} ${r.text}`);
}
{
  // docx：12MB（大部分是圖片），只送文字、不佔額度，所以 11MB 圖片仍放得下（額度 12MB）
  const docx = zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>docx作答內容</w:t></w:r></w:p></w:body></w:document>'),
    "word/media/image1.png": bytes(12 * MB, 3),
  }, { level: 0 });
  driveFiles.dx = { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: docx.length, actual: docx };
  driveFiles.i11 = { mime: "image/png", size: 11 * MB, actual: 11 * MB };
  geminiCalls = [];
  const s = await newSubmission("", ["dx", "i11"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-11 docx 文字送出、不佔額度，11MB 圖片仍送出", r.status === 200 && sentText(geminiCalls[0]).includes("docx作答內容") && sentInline(geminiCalls[0]).includes(11 * MB), `${r.status} ${JSON.stringify(sentInline(geminiCalls[0] ?? { contents: [{ parts: [] }] }))}`);
}
{
  driveFiles.gdoc = { mime: "application/vnd.google-apps.document", actual: 0, text: "Google文件作答" };
  geminiCalls = [];
  const s = await newSubmission("", ["gdoc"]);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-12 Google 文件照舊 export 成文字送出", r.status === 200 && sentText(geminiCalls[0]).includes("Google文件作答"));
}
{
  // R2 的檔被刪了（例如有人手動清 bucket）：要給看得懂的訊息，不能叫 AI 在沒答案的情況下亂評
  await env.ATTACHMENTS.delete(AK);
  geminiCalls = [];
  const s = await newSubmission("第1題：B", []);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-13 R2 答案檔不見：不叫 AI、請老師重新上傳", r.status >= 400 && geminiCalls.length === 0 && (r.json?.error ?? "").includes("重新上傳"), `${r.status} ${r.text}`);
}
{
  // 舊資料：答案檔還存在 D1 的 base64（R2 之前的存法），要照樣讀得到
  const legacy = bytes(MB, 5);
  await env.DB.prepare(
    "UPDATE rubrics SET answer_key_file_r2_key = NULL, answer_key_file_base64 = ?, answer_key_file_name = 'old.pdf', answer_key_file_mime = 'application/pdf', answer_key_file_extracted_text = NULL WHERE coursework_id = 'w1'"
  ).bind(b64(legacy)).run();
  geminiCalls = [];
  const s = await newSubmission("第1題：B", []);
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-14 舊資料（D1 base64）照樣送給 AI", r.status === 200 && sentInline(geminiCalls[0]).includes(MB), `${r.status}`);
  await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: pdfFile("new.pdf", MB) }));
  const row: any = await rubricRow();
  check("2-15 舊資料換新檔：base64 清空、改存 R2", row.b === null && !!row.k);
}
{
  // 鎖定的評分仍然不能被 AI 重評（確認這次沒弄壞既有規則）
  const s = await newSubmission("第1題：B", []);
  await call("POST", `/api/submissions/${s}/ai-grade`);
  await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 8, finalFeedback: "ok", confirm: true });
  geminiCalls = [];
  const r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("2-16 已確認鎖定的不能重評（既有規則沒壞）", r.status === 409 && geminiCalls.length === 0);
  const other = await call("POST", `/api/submissions/${s}/ai-grade`, undefined, "s-t2");
  check("2-17 別的老師不能評我的學生", other.status === 404);
}

console.log("\n== 四、老師手動打分與防呆（v1.7.0） ==");
{
  const s = await newSubmission("第1題：B", []);
  let r = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 6, finalFeedback: "老師自己評", confirm: false });
  const g: any = await env.DB.prepare("SELECT ai_score, final_score, final_feedback, status, locked, rubric_id FROM grades WHERE submission_id = ?").bind(s).first();
  check("4-1 AI 沒評過也能手動打分：新增一列、ai_score 空、狀態老師改過", r.status === 200 && g && g.ai_score === null && g.final_score === 6 && g.status === "teacher_edited" && g.locked === 0 && !!g.rubric_id, `${r.status} ${r.text} ${JSON.stringify(g)}`);
  let h: any = await call("GET", `/api/submissions/${s}/history`);
  check("4-2 修改歷程記到「老師修改」", h.json?.history?.[0]?.source === "TEACHER_EDIT" && h.json.history[0].score === 6);

  geminiCalls = [];
  r = await call("POST", `/api/submissions/${s}/ai-grade`);
  check("4-3 老師改過的，AI 重評沒確認就擋下（409）、沒叫 AI", r.status === 409 && r.json?.code === "overwrite_teacher_edit" && geminiCalls.length === 0, `${r.status} ${r.text}`);
  r = await call("POST", `/api/submissions/${s}/ai-grade?force=1`);
  check("4-4 確認過（force=1）才讓 AI 重評", r.status === 200 && geminiCalls.length === 1, `${r.status}`);

  r = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 9, finalFeedback: "確認", confirm: true });
  const g2: any = await env.DB.prepare("SELECT status, locked, final_score FROM grades WHERE submission_id = ?").bind(s).first();
  h = await call("GET", `/api/submissions/${s}/history`);
  check("4-5 完成批改：鎖定、狀態已完成、歷程記到「老師確認定案」", r.status === 200 && g2.status === "confirmed" && g2.locked === 1 && h.json.history[0].source === "TEACHER_CONFIRM");
  r = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 1, finalFeedback: "偷改", confirm: false });
  const r2 = await call("POST", `/api/submissions/${s}/ai-grade?force=1`);
  check("4-6 鎖定後直接改分、AI 重評（就算 force）都被擋 409", r.status === 409 && r2.status === 409);
}
{
  const s = await newSubmission("x", []);
  const over = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 11, finalFeedback: "", confirm: false });
  const neg = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: -1, finalFeedback: "", confirm: false });
  const long = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 5, finalFeedback: "字".repeat(5001), confirm: false });
  const nan = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: "abc", finalFeedback: "", confirm: false });
  check("4-7 分數超過總分：400 並說明範圍", over.status === 400 && (over.json?.error ?? "").includes("0 到 10"), over.text);
  check("4-8 負分：400", neg.status === 400, neg.text);
  check("4-9 評語超過 5000 字：400", long.status === 400 && (long.json?.error ?? "").includes("5000"), long.text);
  check("4-10 分數不是數字：400", nan.status === 400, nan.text);
  const g: any = await env.DB.prepare("SELECT 1 FROM grades WHERE submission_id = ?").bind(s).first();
  check("4-11 被擋下的都沒有寫進資料庫", !g);
  const ok0 = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 0, finalFeedback: "", confirm: false });
  const okMax = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 10, finalFeedback: "", confirm: false });
  const okDec = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 7.5, finalFeedback: "", confirm: false });
  check("4-12 邊界值 0、滿分、小數 7.5 都可以存", ok0.status === 200 && okMax.status === 200 && okDec.status === 200);
  const other = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 5, finalFeedback: "", confirm: false }, "s-t2");
  const anon = await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 5, finalFeedback: "", confirm: false }, "nobody");
  const ghost = await call("PATCH", `/api/submissions/no-such-id/grade`, { finalScore: 5, finalFeedback: "", confirm: false });
  check("4-13 別的老師 404、沒登入 401、不存在的學生 404", other.status === 404 && anon.status === 401 && ghost.status === 404);
}
{
  const before: any = await env.DB.prepare("SELECT COUNT(*) n FROM grading_calibration_logs").first();
  const s = await newSubmission("x", []);
  await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 8, finalFeedback: "手動定案", confirm: true });
  const after: any = await env.DB.prepare("SELECT COUNT(*) n FROM grading_calibration_logs").first();
  check("4-14 純手動打分不會記進 AI 校正統計（沒有 AI 分數可比）", after.n === before.n);

  const res = await app.fetch(new Request("http://localhost/api/submissions/w1/export.xlsx", { headers: { Cookie: "session=s-t1" } }), env, { waitUntil() {}, passThroughOnException() {} } as any);
  const XLSX = await import("@e965/xlsx");
  const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" });
  const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  check("4-15 手動打的分數與評語有出現在 Excel 成績表", rows.some((x) => x.分數 === 8 && x.評語 === "手動定案" && x.狀態 === "已完成批改"), JSON.stringify(rows.slice(-2)));
}
{
  const r = await call("POST", "/api/submissions/c1/w1/sync");
  const row: any = await env.DB.prepare("SELECT attachments_json, student_name FROM submissions WHERE id = 'cr1'").first();
  const atts = JSON.parse(row?.attachments_json ?? "[]");
  check("4-16 同步繳交：雲端硬碟檔存下原檔連結、連結附件存下網址", r.status === 200 && atts[0]?.url === "https://drive.google.com/file/d/df1/view?usp=drive_web" && atts[1]?.url === "https://www.canva.com/design/abc" && row.student_name === "陳同步", JSON.stringify(atts));
}

console.log("\n== 五、全 App 防呆（v1.8.0） ==");
{
  // 登入：用假的 Google 登入伺服器走 callback
  const cb = async (query: string, cookie = "oauth_state=st1") => {
    const res = await app.fetch(
      new Request(`http://localhost/api/auth/google/callback?${query}`, { headers: { Cookie: cookie } }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as any
    );
    return { status: res.status, location: res.headers.get("Location") ?? "", cookies: res.headers.getSetCookie?.() ?? [res.headers.get("Set-Cookie") ?? ""] };
  };
  const idToken = (sub: string) =>
    "x." + Buffer.from(JSON.stringify({ sub, email: `${sub}@x.tw`, name: "新老師" })).toString("base64url") + ".y";
  const ALL = "openid email profile https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.students.readonly https://www.googleapis.com/auth/classroom.rosters.readonly https://www.googleapis.com/auth/drive.readonly";

  // 導回網址改過之後，瀏覽器不可以重送舊的那一條（會被 Google 擋成 redirect_uri_mismatch）
  {
    const res = await app.fetch(new Request("http://localhost/api/auth/google/login"), env, { waitUntil() {}, passThroughOnException() {} } as any);
    const loc = res.headers.get("Location") ?? "";
    check(
      "5-0 登入跳轉：不准快取、帶正確的 redirect_uri",
      res.status === 302 &&
        (res.headers.get("Cache-Control") ?? "").includes("no-store") &&
        loc.includes(encodeURIComponent(env.GOOGLE_REDIRECT_URI)),
      `${res.status} ${res.headers.get("Cache-Control")}`
    );
  }

  let r = await cb("error=access_denied&state=st1");
  check("5-1 在 Google 按取消：導回登入頁並帶 cancelled", r.status === 302 && r.location.endsWith("/?login_error=cancelled"), r.location);
  r = await cb("code=c1&state=WRONG");
  check("5-2 登入頁停太久（state 對不上）：導回並帶 expired", r.status === 302 && r.location.endsWith("/?login_error=expired"), r.location);
  tokenResponse = { access_token: "a", refresh_token: "rt", expires_in: 3600, id_token: idToken("scopes-teacher"), scope: ALL.replace(" https://www.googleapis.com/auth/drive.readonly", "") };
  r = await cb("code=c1&state=st1");
  const noRow: any = await env.DB.prepare("SELECT 1 FROM teachers WHERE id = 'scopes-teacher'").first();
  check(
    "5-3 沒勾雲端硬碟權限：導回並帶 scopes、點名少了 drive、不建立帳號",
    r.status === 302 && r.location.endsWith("/?login_error=scopes&missing=drive") && !noRow,
    r.location
  );
  // 少兩項就要兩項都點名，老師才不會重新登入之後又少勾另一個
  tokenResponse = { access_token: "a", refresh_token: "rt", expires_in: 3600, id_token: idToken("scopes-teacher2"), scope: "openid email profile https://www.googleapis.com/auth/classroom.rosters.readonly" };
  r = await cb("code=c1&state=st1");
  check("5-3b 少兩項：missing 兩項都帶回去", r.location.endsWith("/?login_error=scopes&missing=courses%2Ccoursework%2Cdrive"), r.location);
  // Google 對還沒送驗證的 App 會把 coursework.students.readonly 換成 student-submissions.students.readonly
  // 發回來（2026-09-20 實測），這種也要放行，不然老師永遠登不進來
  tokenResponse = { access_token: "a", refresh_token: "rt", expires_in: 3600, id_token: idToken("sub-scope"), scope: ALL.replace("coursework.students.readonly", "student-submissions.students.readonly") };
  r = await cb("code=c1&state=st1");
  const subRow: any = await env.DB.prepare("SELECT 1 FROM teachers WHERE id = 'sub-scope'").first();
  check("5-3d Google 換成 student-submissions 也算數：登入成功", !r.location.includes("login_error") && !!subRow, r.location);

  // Google 沒回 scope 欄位時不能當成「全部都有」，要擋下來
  tokenResponse = { access_token: "a", refresh_token: "rt", expires_in: 3600, id_token: idToken("scopes-teacher3"), scope: undefined } as any;
  r = await cb("code=c1&state=st1");
  check("5-3c Google 沒回權限清單：一樣擋下來", r.location.includes("login_error=scopes"), r.location);
  tokenResponse = { access_token: "a", expires_in: 3600, id_token: idToken("norefresh"), scope: ALL };
  r = await cb("code=c1&state=st1");
  check("5-4 沒拿到 refresh token：導回並帶 no_refresh", r.location.endsWith("/?login_error=no_refresh"), r.location);
  tokenResponse = { access_token: "a", refresh_token: "rt", expires_in: 3600, id_token: idToken("ok-teacher"), scope: ALL };
  r = await cb("code=c1&state=st1");
  const okRow: any = await env.DB.prepare("SELECT name FROM teachers WHERE id = 'ok-teacher'").first();
  check("5-5 權限都有：登入成功、發 session cookie、回首頁", r.status === 302 && !r.location.includes("login_error") && r.cookies.some((c: string) => c.startsWith("session=")) && okRow?.name === "新老師", `${r.location} ${JSON.stringify(r.cookies)}`);
  r = await cb("state=st1");
  check("5-6 回來時沒有 code：導回並帶 failed，不出現純文字錯誤頁", r.location.endsWith("/?login_error=failed"), r.location);

  const anon = await call("GET", "/api/courses", undefined, "nobody");
  check("5-7 登入過期：401 且帶 not_logged_in（前端據此跳回登入頁）", anon.status === 401 && anon.json?.code === "not_logged_in", anon.text);
}
{
  classroomStatus = 403;
  const r = await call("GET", "/api/courses");
  check("5-8 Classroom 拒絕（403）：回白話說明、提到學校資訊組", r.status === 403 && r.json?.code === "classroom_forbidden" && (r.json?.error ?? "").includes("資訊組"), r.text);
  classroomStatus = 404;
  const r2 = await call("POST", "/api/submissions/c1/w1/sync");
  check("5-9 Classroom 找不到（404）：回「可能被刪除或封存」", r2.status === 404 && (r2.json?.error ?? "").includes("封存"), r2.text);
  classroomStatus = 200;
}
{
  // 選擇題作答＋重交偵測
  const t1 = "2026-09-01T02:00:00Z";
  classroomSubs = [
    { id: "mc1", userId: "cu1", state: "TURNED_IN", multipleChoiceSubmission: { answer: "地軸傾斜" },
      submissionHistory: [{ stateHistory: { state: "CREATED", stateTimestamp: "2026-08-31T00:00:00Z" } }, { stateHistory: { state: "TURNED_IN", stateTimestamp: t1 } }] },
  ];
  await call("POST", "/api/submissions/c1/w1/sync");
  const row: any = await env.DB.prepare("SELECT content_text, turned_in_at FROM submissions WHERE id = 'mc1'").first();
  check("5-10 選擇題的作答有讀到", row?.content_text === "地軸傾斜", JSON.stringify(row));
  check("5-11 存下最後一次繳交時間", row?.turned_in_at === Math.floor(Date.parse(t1) / 1000), JSON.stringify(row));

  await call("PATCH", "/api/submissions/mc1/grade", { finalScore: 8, finalFeedback: "ok", confirm: true });
  let list = await call("GET", "/api/submissions/w1");
  let mc = list.json.submissions.find((x: any) => x.id === "mc1");
  check("5-12 評分後還沒重交：繳交時間早於評分時間（不提醒）", mc.turned_in_at < mc.grade_updated_at, JSON.stringify({ t: mc.turned_in_at, g: mc.grade_updated_at }));

  const later = new Date((mc.grade_updated_at + 3600) * 1000).toISOString();
  classroomSubs[0].submissionHistory.push(
    { stateHistory: { state: "RECLAIMED_BY_STUDENT", stateTimestamp: later } },
    { stateHistory: { state: "TURNED_IN", stateTimestamp: later } }
  );
  classroomSubs[0].multipleChoiceSubmission.answer = "離太陽比較近";
  await call("POST", "/api/submissions/c1/w1/sync");
  list = await call("GET", "/api/submissions/w1");
  mc = list.json.submissions.find((x: any) => x.id === "mc1");
  check("5-13 評分後重交：繳交時間晚於評分時間（前端會提醒）、內容更新成新答案", mc.turned_in_at > mc.grade_updated_at && mc.content_text === "離太陽比較近" && mc.status === "confirmed", JSON.stringify(mc).slice(0, 200));
  classroomSubs = null;
}
{
  // 評分標準後端驗證
  const base = { courseWorkId: "w1", mode: "rubric" as const };
  const cases: [string, object, string][] = [
    ["總分 0", { ...base, maxPoints: 0, rubricItems: [{ item: "a", maxPoints: 0 }] }, ""],
    ["總分負數", { ...base, maxPoints: -5, rubricItems: [{ item: "a", maxPoints: -5 }] }, ""],
    ["配分負數", { ...base, maxPoints: 10, rubricItems: [{ item: "a", maxPoints: 15 }, { item: "b", maxPoints: -5 }] }, ""],
    ["加總不等於總分", { ...base, maxPoints: 10, rubricItems: [{ item: "a", maxPoints: 4 }, { item: "b", maxPoints: 4 }] }, "要等於總分"],
    ["名稱重複", { ...base, maxPoints: 10, rubricItems: [{ item: "內容", maxPoints: 5 }, { item: "內容", maxPoints: 5 }] }, "不能重複"],
    ["沒有項目", { ...base, maxPoints: 10, rubricItems: [] }, "至少要有一個"],
    ["項目名稱空白", { ...base, maxPoints: 10, rubricItems: [{ item: "  ", maxPoints: 10 }] }, ""],
    ["要求太長", { courseWorkId: "w1", mode: "freetext", maxPoints: 10, instructions: "字".repeat(5001) }, ""],
  ];
  const bad = [];
  for (const [name, body, msg] of cases) {
    const r = await call("POST", "/api/rubrics", body);
    if (!(r.status === 400 && (!msg || (r.json?.error ?? "").includes(msg)))) bad.push(`${name}→${r.status} ${r.text.slice(0, 60)}`);
  }
  check(`5-14 評分標準的 ${cases.length} 種錯誤值都回 400 並說明`, bad.length === 0, bad.join(" | "));
  const ok = await call("POST", "/api/rubrics", { ...base, maxPoints: 10, rubricItems: [{ item: "內容", maxPoints: 6 }, { item: "表達", maxPoints: 4 }] });
  check("5-15 正確的量表可以存", ok.status === 200, ok.text);

  const g = await call("GET", "/api/rubrics/w1");
  const expected: any = await env.DB.prepare("SELECT COUNT(*) n, MAX(g.final_score) m FROM grades g JOIN submissions s ON s.id = g.submission_id WHERE s.coursework_id = 'w1'").first();
  check("5-16 讀評分標準時回傳 Classroom 滿分、已評分人數、最高分", g.json?.courseworkMaxPoints === 10 && g.json?.gradedCount === expected.n && g.json?.maxGivenScore === expected.m && expected.n > 0, JSON.stringify({ c: g.json?.courseworkMaxPoints, n: g.json?.gradedCount, m: g.json?.maxGivenScore, e: expected }));
}
{
  const r = await call("POST", "/api/rubrics", { courseWorkId: "w1", mode: "answer_key", maxPoints: 10, answerKeyFile: { name: "k.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: Buffer.from("PK\x03\x04broken").toString("base64") } });
  check("5-17 壞掉的 Excel：白話說明，不外洩技術錯誤", r.status === 400 ? (r.json?.error ?? "").includes("另存") : true, `${r.status} ${r.text.slice(0, 120)}`);
}

console.log("\n== 六、協同教學：一門課多位老師（v1.9.0） ==");
{
  // t2 也是 c1 的老師（Classroom 回同一門課給他），t3 完全沒有這門課
  const now2 = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO teachers VALUES ('t3','t3@x.tw','老師三',NULL,'x','fake-token',?,?,?)").bind(now2 + 3000, now2, now2).run();
  await env.SESSIONS.put("session:s-t3", "t3");

  const before: any = await env.DB.prepare("SELECT COUNT(*) n FROM course_teachers WHERE course_id = 'c1'").first();
  check("6-1 舊資料已經搬進 course_teachers（migration）", before.n >= 1, JSON.stringify(before));

  const r = await call("GET", "/api/courses", undefined, "s-t2");
  const rows: any = await env.DB.prepare("SELECT teacher_id FROM course_teachers WHERE course_id = 'c1' ORDER BY teacher_id").all();
  const ids = rows.results.map((x: any) => x.teacher_id);
  check("6-2 第二位老師同步課程：course_teachers 同時有兩位", r.status === 200 && ids.includes("t1") && ids.includes("t2"), JSON.stringify(ids));
  check("6-3 課程清單回傳老師人數（前端據此提醒分數共用）", (r.json?.courses ?? []).find((x: any) => x.id === "c1")?.teacherCount === 2, JSON.stringify(r.json?.courses));

  const owner: any = await env.DB.prepare("SELECT teacher_id FROM courses WHERE id = 'c1'").first();
  check("6-4 courses.teacher_id 仍是第一位同步的人（只當紀錄）", owner.teacher_id === "t1");

  // t2 走完整流程
  const cw = await call("GET", "/api/courses/c1/coursework", undefined, "s-t2");
  check("6-5 第二位老師讀得到作業清單", cw.status === 200, cw.text.slice(0, 120));
  const rub = await call("POST", "/api/rubrics", { courseWorkId: "w1", mode: "freetext", instructions: "第二位老師設的標準", maxPoints: 10 }, "s-t2");
  const list = await call("GET", "/api/submissions/w1", undefined, "s-t2");
  check("6-6 第二位老師可以設評分標準、看學生清單", rub.status === 200 && list.status === 200 && list.json.submissions.length > 0, `${rub.status} ${list.status}`);

  const s1 = await newSubmission("協同教學測試", []);
  const ai = await call("POST", `/api/submissions/${s1}/ai-grade`, undefined, "s-t2");
  check("6-7 第二位老師可以叫 AI 評分", ai.status === 200, ai.text.slice(0, 120));
  const edit2 = await call("PATCH", `/api/submissions/${s1}/grade`, { finalScore: 9, finalFeedback: "老師二改的", confirm: false }, "s-t2");
  const seenByT1 = await call("GET", "/api/submissions/w1", undefined, "s-t1");
  const rowT1 = seenByT1.json.submissions.find((x: any) => x.id === s1);
  check("6-8 第二位老師改的分數，第一位老師看得到（同一份成績）", edit2.status === 200 && rowT1.final_score === 9 && rowT1.final_feedback === "老師二改的", JSON.stringify(rowT1).slice(0, 150));

  const conf = await call("PATCH", `/api/submissions/${s1}/grade`, { finalScore: 10, finalFeedback: "老師一定案", confirm: true }, "s-t1");
  const unlock = await call("POST", `/api/submissions/${s1}/unlock`, undefined, "s-t2");
  const hist = await call("GET", `/api/submissions/${s1}/history`, undefined, "s-t2");
  check("6-9 兩位老師都能確認、解鎖、看同一份修改歷程", conf.status === 200 && unlock.status === 200 && hist.status === 200 && hist.json.history.length >= 3, `${conf.status} ${unlock.status} ${hist.json?.history?.length}`);

  const xlsx = await app.fetch(new Request("http://localhost/api/submissions/w1/export.xlsx", { headers: { Cookie: "session=s-t2" } }), env, { waitUntil() {}, passThroughOnException() {} } as any);
  check("6-10 第二位老師可以下載成績表", xlsx.status === 200 && (xlsx.headers.get("Content-Type") ?? "").includes("spreadsheet"), String(xlsx.status));

  // 不是這門課的老師：每一支都要被擋
  const blocked: string[] = [];
  const t3 = [
    ["讀作業", await call("GET", "/api/courses/c1/coursework", undefined, "s-t3")],
    ["看學生", await call("GET", "/api/submissions/w1", undefined, "s-t3")],
    ["設評分標準", await call("POST", "/api/rubrics", { courseWorkId: "w1", mode: "freetext", instructions: "x", maxPoints: 10 }, "s-t3")],
    ["拉繳交", await call("POST", "/api/submissions/c1/w1/sync", undefined, "s-t3")],
    ["AI 評分", await call("POST", `/api/submissions/${s1}/ai-grade`, undefined, "s-t3")],
    ["改分數", await call("PATCH", `/api/submissions/${s1}/grade`, { finalScore: 1, finalFeedback: "", confirm: false }, "s-t3")],
    ["解鎖", await call("POST", `/api/submissions/${s1}/unlock`, undefined, "s-t3")],
    ["看歷程", await call("GET", `/api/submissions/${s1}/history`, undefined, "s-t3")],
    ["讀評分標準", await call("GET", "/api/rubrics/w1", undefined, "s-t3")],
  ] as [string, any][];
  for (const [name, res] of t3) if (res.status !== 404) blocked.push(`${name}=${res.status}`);
  const exportT3 = await app.fetch(new Request("http://localhost/api/submissions/w1/export.xlsx", { headers: { Cookie: "session=s-t3" } }), env, { waitUntil() {}, passThroughOnException() {} } as any);
  if (exportT3.status !== 404) blocked.push(`下載成績表=${exportT3.status}`);
  check(`6-11 不是這門課的老師：${t3.length + 1} 支 API 全部 404`, blocked.length === 0, blocked.join(" | "));

  const tpl = await call("GET", "/api/rubric-templates", undefined, "s-t2");
  check("6-12 個人範本不共用（第二位老師看到的是自己的）", tpl.status === 200 && (tpl.json?.templates ?? []).length === 0, tpl.text.slice(0, 100));
}

console.log("\n== 七、同網域與來源檢查（v1.10.0） ==");
{
  const withOrigin = async (method: string, path: string, origin: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Cookie: "session=s-t1" };
    if (origin) headers.Origin = origin;
    const res = await app.fetch(
      new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as any
    );
    return { status: res.status, text: await res.text() };
  };
  const s1 = await newSubmission("來源檢查", []);
  const body = { finalScore: 5, finalFeedback: "x", confirm: false };

  const evil = await withOrigin("PATCH", `/api/submissions/${s1}/grade`, "https://evil.example.com", body);
  check("7-1 別的網站冒用老師身分送改分請求：403 擋下", evil.status === 403 && evil.text.includes("不是從 classAI"), `${evil.status} ${evil.text.slice(0, 80)}`);

  const own = await withOrigin("PATCH", `/api/submissions/${s1}/grade`, (env as any).APP_URL, body);
  check("7-2 從自家網站送出的：正常放行", own.status === 200, `${own.status} ${own.text.slice(0, 80)}`);

  const localhost = await withOrigin("PATCH", `/api/submissions/${s1}/grade`, "http://localhost:5173", body);
  check("7-3 本機開發的網址：放行", localhost.status === 200, `${localhost.status}`);

  const readEvil = await withOrigin("GET", "/api/submissions/w1", "https://evil.example.com");
  check("7-4 純讀取（GET）不受影響", readEvil.status === 200, `${readEvil.status}`);

  const noOrigin = await withOrigin("POST", `/api/submissions/${s1}/unlock`, null);
  check("7-5 沒有 Origin 的呼叫（伺服器對伺服器）：放行", noOrigin.status === 200, `${noOrigin.status}`);
}

console.log("\n== 八、AI 用量上限（v1.11.0） ==");
{
  const { taipeiDay } = await import("../src/lib/usage.ts");
  const today = taipeiDay();
  const usedOf = async (t: string) =>
    ((await env.DB.prepare("SELECT used FROM ai_usage WHERE teacher_id = ? AND day = ?").bind(t, today).first<{ used: number }>())?.used) ?? 0;
  const setUsed = async (t: string, n: number, day = today) =>
    env.DB.prepare("INSERT INTO ai_usage (teacher_id, day, used, updated_at) VALUES (?, ?, ?, 0) ON CONFLICT(teacher_id, day) DO UPDATE SET used = excluded.used").bind(t, day, n).run();
  // 每分鐘上限的 KV 紀錄清掉，免得前面的測試把這一分鐘的額度用掉
  const clearMinute = async () => {
    const k = `ratelimit:t1:${Math.floor(Date.now() / 60000)}`;
    await env.SESSIONS.delete(k);
  };

  await setUsed("t1", 0);
  await clearMinute();
  const before = await usedOf("t1");
  const s1 = await newSubmission("用量測試", []);
  geminiCalls = [];
  let r = await call("POST", `/api/submissions/${s1}/ai-grade`);
  check("8-1 正常評分：用量加一、回傳今天剩幾次", r.status === 200 && (await usedOf("t1")) === before + 1 && typeof r.json?.remainingToday === "number", `${r.status} used=${await usedOf("t1")} rem=${r.json?.remainingToday}`);

  const usage = await call("GET", "/api/usage");
  check("8-2 查詢用量：用了幾次、上限、還剩幾次都對", usage.status === 200 && usage.json.usedToday === (await usedOf("t1")) && usage.json.remainingToday === usage.json.dailyLimit - usage.json.usedToday, usage.text);

  // 灌到當天上限
  await setUsed("t1", usage.json.dailyLimit);
  await clearMinute();
  geminiCalls = [];
  const s2 = await newSubmission("用量測試2", []);
  r = await call("POST", `/api/submissions/${s2}/ai-grade`);
  check("8-3 超過每天上限：429、沒有呼叫 AI", r.status === 429 && r.json?.code === "quota_daily" && geminiCalls.length === 0, `${r.status} ${r.text.slice(0, 80)}`);
  check("8-4 訊息講明天會重置、可以自己打分", (r.json?.error ?? "").includes("明天") && (r.json?.error ?? "").includes("自己打分"), r.json?.error);
  const manual = await call("PATCH", `/api/submissions/${s2}/grade`, { finalScore: 7, finalFeedback: "AI 額度滿了自己打", confirm: false });
  check("8-5 額度用完，手動打分照樣可以", manual.status === 200, manual.text.slice(0, 80));

  // 另一位老師不受影響（t2 是 c1 的協同老師）
  await clearMinute();
  const t2Used = await usedOf("t2");
  // 另開一位學生：s2 在 8-5 被手動打過分，AI 重評會被覆蓋保護擋下（那是另一條規則）
  const s2b = await newSubmission("另一位老師評", []);
  const r2 = await call("POST", `/api/submissions/${s2b}/ai-grade`, undefined, "s-t2");
  check("8-6 每位老師分開算：另一位老師還能評", r2.status === 200 && (await usedOf("t2")) === t2Used + 1, `${r2.status} ${r2.text.slice(0, 60)}`);

  // 昨天的用量不影響今天
  const yesterday = taipeiDay(Date.now() - 86400000);
  await setUsed("t1", 0);
  await setUsed("t1", 9999, yesterday);
  await clearMinute();
  const u2 = await call("GET", "/api/usage");
  check("8-7 昨天用爆不影響今天", u2.json.usedToday === 0 && u2.json.remainingToday === u2.json.dailyLimit, u2.text);

  // AI 自己失敗不扣老師的次數
  await setUsed("t1", 0);
  await clearMinute();
  geminiFails = true;
  const s3 = await newSubmission("AI 會失敗", []);
  r = await call("POST", `/api/submissions/${s3}/ai-grade`);
  geminiFails = false;
  check("8-8 AI 失敗不扣次數", r.status >= 400 && (await usedOf("t1")) === 0, `${r.status} used=${await usedOf("t1")}`);

  // 提早結束的情況（鎖定）也不扣
  await clearMinute();
  const s4 = await newSubmission("鎖定的", []);
  await call("PATCH", `/api/submissions/${s4}/grade`, { finalScore: 8, finalFeedback: "定案", confirm: true });
  const usedBeforeLocked = await usedOf("t1");
  r = await call("POST", `/api/submissions/${s4}/ai-grade`);
  check("8-9 鎖定／沒內容這種根本不用打 AI 的，不扣次數", r.status === 409 && (await usedOf("t1")) === usedBeforeLocked, `${r.status} used=${await usedOf("t1")}`);

  // 每分鐘上限
  await setUsed("t1", 0);
  const minuteKey = `ratelimit:t1:${Math.floor(Date.now() / 60000)}`;
  await env.SESSIONS.put(minuteKey, "999", { expirationTtl: 120 });
  geminiCalls = [];
  const s5 = await newSubmission("連點", []);
  r = await call("POST", `/api/submissions/${s5}/ai-grade`);
  check("8-10 連點太快：429 且訊息不同（請等一分鐘）、沒呼叫 AI", r.status === 429 && r.json?.code === "quota_minute" && (r.json?.error ?? "").includes("一分鐘") && geminiCalls.length === 0, `${r.status} ${r.text.slice(0, 80)}`);
  await env.SESSIONS.delete(minuteKey);
  await setUsed("t1", 0);
}

console.log("\n== 九、評分標準校準範例（rubric_calibration_examples，v1.14.0） ==");
{
  const { taipeiDay } = await import("../src/lib/usage.ts");
  const today = taipeiDay();
  await env.DB.prepare(
    "INSERT INTO ai_usage (teacher_id, day, used, updated_at) VALUES ('t1', ?, 0, 0) ON CONFLICT(teacher_id, day) DO UPDATE SET used = excluded.used"
  )
    .bind(today)
    .run();
  await env.SESSIONS.delete(`ratelimit:t1:${Math.floor(Date.now() / 60000)}`);

  const rubricRowNow: any = await env.DB.prepare("SELECT id FROM rubrics WHERE coursework_id = 'w1'").first();
  const rubricId = rubricRowNow.id;
  await env.DB.prepare("DELETE FROM rubric_calibration_examples WHERE rubric_id = ?").bind(rubricId).run();

  const sA = await newSubmission("學生作答A：光合作用需要陽光、水和二氧化碳。", []);
  const gA = await call("POST", `/api/submissions/${sA}/ai-grade`); // 假 Gemini 固定回 7 分
  check("9-0 AI 評分成功（前置）", gA.status === 200, gA.text.slice(0, 100));
  const confA = await call("PATCH", `/api/submissions/${sA}/grade`, { finalScore: 1, finalFeedback: "答得不完整", confirm: true });
  check("9-1 老師大幅改分後確認：回 200", confA.status === 200, confA.text.slice(0, 100));

  const rows1: any = await env.DB.prepare("SELECT * FROM rubric_calibration_examples WHERE rubric_id = ?").bind(rubricId).all();
  check("9-2 存了一筆校準範例", rows1.results.length === 1, JSON.stringify(rows1.results));
  const ex1: any = rows1.results[0];
  check(
    "9-3 範例內容對：學生節錄、AI建議分、老師定案分都存對",
    ex1.student_excerpt.includes("光合作用") && ex1.ai_score === 7 && ex1.teacher_final_score === 1 && ex1.teacher_final_feedback === "答得不完整",
    JSON.stringify(ex1)
  );

  const sB = await newSubmission("學生作答B：普通答案", []);
  await call("POST", `/api/submissions/${sB}/ai-grade`);
  await call("PATCH", `/api/submissions/${sB}/grade`, { finalScore: 7.3, finalFeedback: "微調", confirm: true }); // 差距 0.3/10=3%，在門檻內
  const countAfterSmallEdit: any = await env.DB.prepare("SELECT COUNT(*) n FROM rubric_calibration_examples WHERE rubric_id = ?").bind(rubricId).first();
  check("9-4 分差在門檻內（≤15%）不存範例", countAfterSmallEdit.n === 1, JSON.stringify(countAfterSmallEdit));

  geminiCalls = [];
  const sC = await newSubmission("學生作答C：植物利用光合作用產生氧氣", []);
  await call("POST", `/api/submissions/${sC}/ai-grade`);
  const lastCall = geminiCalls[geminiCalls.length - 1];
  const sysText = (lastCall?.systemInstruction?.parts ?? []).map((p: any) => p.text).join("\n");
  check(
    "9-5 評分 prompt 帶到校準參考段落",
    sysText.includes("校準參考") && sysText.includes("光合作用") && sysText.includes("答得不完整"),
    sysText.slice(0, 500)
  );

  const firstExampleId = ex1.id;
  for (let i = 0; i < 8; i++) {
    const s = await newSubmission(`學生作答補${i}：內容${i}`, []);
    await call("POST", `/api/submissions/${s}/ai-grade`);
    await call("PATCH", `/api/submissions/${s}/grade`, { finalScore: 0, finalFeedback: `修正${i}`, confirm: true });
  }
  const rowsFinal: any = await env.DB.prepare("SELECT id FROM rubric_calibration_examples WHERE rubric_id = ? ORDER BY created_at ASC").bind(rubricId).all();
  check("9-6 範例數量不超過上限（8筆）", rowsFinal.results.length === 8, `${rowsFinal.results.length}`);
  check(
    "9-7 超過上限後，最舊的第一筆被刪掉",
    !rowsFinal.results.some((r: any) => r.id === firstExampleId),
    JSON.stringify(rowsFinal.results.map((r: any) => r.id))
  );
}

if (process.env.REAL_GEMINI === "1") {
  console.log("\n== 三、真的打 Gemini（PDF 答案檔在 R2 ＋ 學生交手寫照片） ==");
  geminiMode = "real";
  const ak = readFileSync(process.env.REAL_AK_PDF!);
  await call("POST", "/api/rubrics", rubricBody({ answerKeyFile: { name: "標準答案.pdf", mimeType: "application/pdf", base64: b64(ak) } }));
  driveFiles.right = { mime: "image/png", size: 0, actual: new Uint8Array(readFileSync(process.env.REAL_STU_RIGHT!)) };
  driveFiles.wrong = { mime: "image/png", size: 0, actual: new Uint8Array(readFileSync(process.env.REAL_STU_WRONG!)) };
  for (const [id, expectHigh] of [["right", true], ["wrong", false]] as const) {
    let r: any;
    for (let i = 0; i < 4; i++) {
      const s = await newSubmission("", [id]);
      r = await call("POST", `/api/submissions/${s}/ai-grade`);
      if (r.status !== 429) break;
      console.log("      （額度滿了，等 40 秒再試）");
      await new Promise((ok) => setTimeout(ok, 40_000));
    }
    const score = r.json?.grade?.score;
    check(`3-${expectHigh ? 1 : 2} ${expectHigh ? "全對照片拿高分（≥8）" : "全錯照片拿低分（≤3）"}`, r.status === 200 && (expectHigh ? score >= 8 : score <= 3), `${r.status} ${r.text.slice(0, 200)}`);
    if (r.status === 200) console.log(`      分數 ${score}，模型 ${r.json.model}｜${String(r.json.grade.feedback).replace(/\n/g, " ").slice(0, 60)}`);
  }
}

console.log("\n== 十、背景自動預批改（v1.17.0） ==");
{
  const { runAutoGrade, MAX_ATTEMPTS } = await import("../src/lib/autograde.ts");
  // 額度放寬，免得前面各段在同一分鐘用掉的次數干擾這段（額度本身另外測 10-11）
  const e10: any = { ...env, DAILY_AI_LIMIT: "1000", MINUTE_AI_LIMIT: "1000" };
  const t = () => Math.floor(Date.now() / 1000);
  const hist = (sec: number) => [{ stateHistory: { state: "TURNED_IN", stateTimestamp: new Date(sec * 1000).toISOString() } }];
  const grade = (id: string) => env.DB.prepare("SELECT status, ai_score, final_score, locked FROM grades WHERE submission_id = ?").bind(id).first();
  const sub = (id: string) => env.DB.prepare("SELECT autograde_error, autograde_attempts FROM submissions WHERE id = ?").bind(id).first();

  // 前面各段存評分標準時已經登記過接手，先全部停掉，只看這段自己的作業
  const w1Watched = await env.DB.prepare("SELECT 1 FROM autograde_watch WHERE coursework_id = 'w1'").first();
  check("10-0 存評分標準就會登記背景接手", !!w1Watched);
  await env.DB.prepare("UPDATE autograde_watch SET watch_until = 0").run();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO coursework VALUES ('w3','c1','光合作用短答',NULL,10,?)").bind(t()),
    env.DB.prepare(
      "INSERT INTO rubrics (id, coursework_id, mode, instructions, max_points, created_at, updated_at) VALUES ('r3','w3','freetext','看有沒有講到光能轉化學能',10,?,?)"
    ).bind(t(), t()),
  ]);
  // 老師二在第六段已經是 c1 的協同老師；老師三（第六段建的）不是這門課的老師
  const watchRes = await call("POST", "/api/submissions/w3/watch");
  const otherWatch = await call("POST", "/api/submissions/w3/watch", undefined, "s-t3");
  check("10-1 打開批改頁登記接手；別班老師不行", watchRes.status === 200 && otherWatch.status === 404, `${watchRes.status}/${otherWatch.status}`);

  classroomSubs = [
    { id: "ag-a", userId: "cu1", state: "TURNED_IN", shortAnswerSubmission: { answer: "植物把光能轉成化學能" }, submissionHistory: hist(t() - 1200) },
    { id: "ag-b", userId: "cu2", state: "TURNED_IN", shortAnswerSubmission: { answer: "剛交的" }, submissionHistory: hist(t() - 180) },
    { id: "ag-c", userId: "cu3", state: "TURNED_IN", assignmentSubmission: { attachments: [{ link: { url: "https://youtu.be/x", title: "我的影片" } }] }, submissionHistory: hist(t() - 1200) },
    { id: "ag-n", userId: "cu4", state: "CREATED" },
  ];
  geminiCalls = [];
  let s1 = await runAutoGrade(e10);
  check("10-2 滿 10 分鐘的評了、剛交 3 分鐘的先不評", (await grade("ag-a"))?.status === "ai_suggested" && !(await grade("ag-b")) && s1.graded === 1, JSON.stringify(s1));
  const cErr: any = await sub("ag-c");
  check("10-3 只交連結：標「需要人工批」、沒叫 AI", !!cErr?.autograde_error && geminiCalls.length === 1, `${cErr?.autograde_error} calls=${geminiCalls.length}`);

  geminiCalls = [];
  await runAutoGrade(e10);
  check("10-4 再跑一輪：評過的不重評、人工批的不重試", geminiCalls.length === 0, `calls=${geminiCalls.length}`);

  const inbox1 = await call("GET", "/api/inbox");
  const item = inbox1.json?.items?.find((i: any) => i.courseWorkId === "w3");
  const inboxOther = await call("GET", "/api/inbox", undefined, "s-t3");
  check(
    "10-5 首頁待確認：1 份 AI 建議＋1 份人工批；別的老師看不到",
    !!item && item.green + item.yellow + item.red === 1 && item.needsTeacher === 1 && !inboxOther.json.items.some((i: any) => i.courseWorkId === "w3"),
    JSON.stringify(inbox1.json).slice(0, 300)
  );

  // 學生重交（老師還沒動過 AI 建議）→ 重評
  await env.DB.prepare("UPDATE grades SET graded_at = ? WHERE submission_id = 'ag-a'").bind(t() - 3600).run();
  classroomSubs[0] = { ...classroomSubs[0], shortAnswerSubmission: { answer: "改過的答案" }, submissionHistory: hist(t() - 1200) };
  geminiCalls = [];
  await runAutoGrade(e10);
  const hist1 = await env.DB.prepare("SELECT source FROM grade_history WHERE submission_id = 'ag-a' ORDER BY version_number DESC").first<any>();
  check("10-6 AI 建議還沒被老師動過，學生重交 → 自動重評", geminiCalls.length === 1 && hist1?.source === "AI_REGRADE", `calls=${geminiCalls.length} ${hist1?.source}`);

  // 老師確認鎖定後學生又重交 → 不能被蓋掉
  await call("PATCH", "/api/submissions/ag-a/grade", { finalScore: 9, finalFeedback: "老師定案", confirm: true });
  await env.DB.prepare("UPDATE grades SET graded_at = ?, updated_at = ? WHERE submission_id = 'ag-a'").bind(t() - 3600, t() - 3600).run();
  classroomSubs[0] = { ...classroomSubs[0], shortAnswerSubmission: { answer: "又改了" }, submissionHistory: hist(t() - 900) };
  geminiCalls = [];
  await runAutoGrade(e10);
  const locked: any = await grade("ag-a");
  const inbox2 = await call("GET", "/api/inbox");
  const item2 = inbox2.json?.items?.find((i: any) => i.courseWorkId === "w3");
  check("10-7 老師確認鎖定的，學生重交也不蓋掉，首頁列為「重交」", geminiCalls.length === 0 && locked?.final_score === 9 && locked?.locked === 1 && item2?.resubmitted === 1, JSON.stringify({ locked, item2 }));

  // 只交連結的學生改交文字 → 清掉人工批標記、AI 重新評
  classroomSubs[2] = { ...classroomSubs[2], assignmentSubmission: undefined, shortAnswerSubmission: { answer: "改成打字回答" }, submissionHistory: hist(t() - 700) };
  await runAutoGrade(e10);
  const c2: any = await sub("ag-c");
  check("10-8 人工批的學生重交 → 標記清掉、AI 重新評", c2?.autograde_error === null && (await grade("ag-c"))?.status === "ai_suggested", JSON.stringify(c2));

  // AI 一直失敗 → 前兩輪留著重試，第三輪標人工批
  classroomSubs.push({ id: "ag-d", userId: "cu5", state: "TURNED_IN", shortAnswerSubmission: { answer: "失敗測試" }, submissionHistory: hist(t() - 1200) });
  geminiFails = true;
  const attemptsSeen: number[] = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await runAutoGrade(e10);
    attemptsSeen.push(((await sub("ag-d")) as any)?.autograde_attempts);
  }
  geminiFails = false;
  const d: any = await sub("ag-d");
  check("10-9 AI 連續失敗 3 次才標人工批", attemptsSeen.join(",") === "1,2,2" && String(d?.autograde_error).includes("連續 3 次"), `${attemptsSeen} ${d?.autograde_error}`);

  // 老師頁面正在評同一位 → 排程不重複叫 AI
  classroomSubs.push({ id: "ag-e", userId: "cu6", state: "TURNED_IN", shortAnswerSubmission: { answer: "搶鎖測試" }, submissionHistory: hist(t() - 1200) });
  await env.DB.prepare("INSERT INTO submissions (id, coursework_id, student_id, student_name, state, content_text, attachments_json, fetched_at) VALUES ('ag-e','w3','cu6','學生','TURNED_IN','搶鎖測試','[]',?)").bind(t()).run();
  await env.SESSIONS.put("grading:ag-e", "1", { expirationTtl: 300 });
  geminiCalls = [];
  await runAutoGrade(e10);
  const e1: any = await sub("ag-e");
  check("10-10 別處正在評同一位：排程跳過、不叫 AI、不記錯", geminiCalls.length === 0 && !(await grade("ag-e")) && e1?.autograde_error === null);
  await env.SESSIONS.delete("grading:ag-e");

  // 額度用完 → 排程停手，不記成人工批（明天再試）
  const used: any = await env.DB.prepare("SELECT used FROM ai_usage WHERE teacher_id = 't1' AND day = ?").bind(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)).first();
  geminiCalls = [];
  await runAutoGrade({ ...env, DAILY_AI_LIMIT: String(used?.used ?? 1), MINUTE_AI_LIMIT: "1000" });
  const e2: any = await sub("ag-e");
  check("10-11 額度用完：不叫 AI、也不標人工批", geminiCalls.length === 0 && e2?.autograde_error === null && !(await grade("ag-e")), `calls=${geminiCalls.length}`);
  await runAutoGrade(e10);
  check("10-11b 額度恢復後下一輪接著評", (await grade("ag-e"))?.status === "ai_suggested");

  // 老師的 Google 授權失效 → 記下來、首頁提醒；老師打開批改頁就清掉
  classroomStatus = 401;
  await runAutoGrade(e10);
  classroomStatus = 200;
  const w: any = await env.DB.prepare("SELECT last_error FROM autograde_watch WHERE coursework_id = 'w3'").first();
  const inbox3 = await call("GET", "/api/inbox");
  const item3 = inbox3.json?.items?.find((i: any) => i.courseWorkId === "w3");
  await call("POST", "/api/submissions/w3/watch");
  const w2: any = await env.DB.prepare("SELECT last_error FROM autograde_watch WHERE coursework_id = 'w3'").first();
  check("10-12 授權失效：記 auth_expired、首頁看得到；老師回來就清掉", w?.last_error === "auth_expired" && item3?.lastError === "auth_expired" && w2?.last_error === null, JSON.stringify({ w, w2 }));

  // 批改頁清單帶出人工批原因
  const list = await call("GET", "/api/submissions/w3");
  const dRow = list.json?.submissions?.find((s: any) => s.id === "ag-d");
  check("10-13 批改頁清單帶出「需要人工批」原因與最後自動更新時間", !!dRow?.autograde_error && typeof list.json?.autoSyncedAt === "number");

  const before14 = (await call("GET", "/api/inbox")).json.items.find((i: any) => i.courseWorkId === "w3")?.needsTeacher;
  await call("PATCH", "/api/submissions/ag-d/grade", { finalScore: 6, finalFeedback: "老師自己批", confirm: false });
  const after14 = (await call("GET", "/api/inbox")).json.items.find((i: any) => i.courseWorkId === "w3")?.needsTeacher;
  const d14: any = await sub("ag-d");
  check("10-14 老師自己打分後，「要你自己批」提醒清掉、首頁數字跟著減", d14?.autograde_error === null && after14 === before14 - 1, `${before14}→${after14}`);

  classroomSubs = null;
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
await dispose();
process.exit(fail ? 1 : 0);
