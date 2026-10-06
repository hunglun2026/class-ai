/**
 * 整合測試（v1.21.0）：常用評語庫、評語一鍵調整。id 都用 pr 開頭。
 * 跑法：npm run test:it（第四支）
 */
import { getPlatformProxy } from "wrangler";
import app from "../src/index.ts";
import { buildRewritePrompt } from "../src/lib/feedback-rewrite.ts";

const { env: realEnv, dispose } = await getPlatformProxy<any>({ persist: { path: ".wrangler/state-it/v3" } });
const env: any = realEnv;
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      → ${detail}` : ""}`);
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
async function call(method: string, path: string, body?: unknown, sess = "s-pr1") {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `session=${sess}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, ctx);
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

let geminiStatus = 200;
let geminiReply: any = { feedback: "改寫後的評語" };
const geminiCalls: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls.push(JSON.parse(init.body));
    if (geminiStatus !== 200) return new Response("RESOURCE_EXHAUSTED", { status: geminiStatus });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReply) }] } }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

const now = Math.floor(Date.now() / 1000);
await env.DB.batch([
  env.DB.prepare("INSERT INTO teachers VALUES ('prt1','pr1@x.tw','評語老師',NULL,'x','fake-token',?,?,?)").bind(now + 3000, now, now),
  env.DB.prepare("INSERT INTO teachers VALUES ('prt2','pr2@x.tw','別班老師',NULL,'x','fake-token',?,?,?)").bind(now + 3000, now, now),
]);
await env.SESSIONS.put("session:s-pr1", "prt1");
await env.SESSIONS.put("session:s-pr2", "prt2");

console.log("\n== 十九、常用評語庫 ==");
{
  const empty = await call("GET", "/api/phrases");
  check("19-1 一開始是空的", empty.status === 200 && empty.json?.phrases?.length === 0, empty.text);
  const a = await call("POST", "/api/phrases", { text: "  字跡工整，請保持  " });
  check("19-2 新增成功並去掉前後空白", a.status === 200 && a.json?.text === "字跡工整，請保持", a.text);
  const dup = await call("POST", "/api/phrases", { text: "字跡工整，請保持" });
  check("19-3 重複的句子回同一筆，不會多一筆", dup.json?.id === a.json?.id, dup.text);
  check("19-4 空白句子：400", (await call("POST", "/api/phrases", { text: "   " })).status === 400);
  check("19-5 超過 120 字：400", (await call("POST", "/api/phrases", { text: "字".repeat(121) })).status === 400);
  const list = await call("GET", "/api/phrases");
  check("19-6 列表只有 1 句", list.json?.phrases?.length === 1, list.text);
  const other = await call("GET", "/api/phrases", undefined, "s-pr2");
  check("19-7 別的老師看不到", other.json?.phrases?.length === 0, other.text);
  const steal = await call("DELETE", `/api/phrases/${a.json.id}`, undefined, "s-pr2");
  check("19-8 別的老師刪不掉：404", steal.status === 404, steal.text);
  for (let i = 0; i < 29; i++) await call("POST", "/api/phrases", { text: `第 ${i} 句` });
  const over = await call("POST", "/api/phrases", { text: "第 31 句" });
  check("19-9 滿 30 句後再新增：400 並說要先刪", over.status === 400 && over.json?.error?.includes("30"), over.text);
  const del = await call("DELETE", `/api/phrases/${a.json.id}`);
  check("19-10 自己刪自己的：成功", del.status === 200, del.text);
  check("19-11 沒登入：401", (await call("GET", "/api/phrases", undefined, "nobody")).status === 401);
}

console.log("\n== 二十、評語一鍵調整 ==");
{
  const body = { action: "shorter", feedback: "第 1 題很好。第 2 題有迷思。第 3 題答非所問。", score: 13, maxPoints: 30 };
  const r = await call("POST", "/api/feedback-rewrite", body);
  const sent = geminiCalls.at(-1);
  const sys = sent.systemInstruction.parts[0].text as string;
  const usr = sent.contents[0].parts[0].text as string;
  // 假 AI 回的「改寫後的評語」把題號都刪了，保底會把原評語提到題號的那行補在後面
  check("20-1 成功：回改寫後評語，刪掉的題號補回", r.status === 200 && r.json?.feedback === "改寫後的評語\n第 1 題很好。第 2 題有迷思。第 3 題答非所問。", r.text);
  check("20-2 指令帶了動作、分數與滿分", sys.includes("縮短") && sys.includes("13 分") && sys.includes("滿分 30"), sys);
  check("20-3 評語放在隨機邊界標籤裡當資料", /<fb_[0-9a-f]{12}>/.test(usr) && usr.includes("第 2 題有迷思"), usr);
  check("20-4 扣了 1 次 AI", typeof r.json?.remainingToday === "number");
  for (const [act, kw] of [["warmer", "溫暖"], ["stricter", "嚴格"], ["onepara", "一段話"]] as const) {
    check(`20-5 動作 ${act} 的指令內容不同`, buildRewritePrompt(act, "t", 5, 10).includes(kw));
  }
  check("20-6 不認得的動作：400", (await call("POST", "/api/feedback-rewrite", { ...body, action: "hack" })).status === 400);
  check("20-7 評語空白：400", (await call("POST", "/api/feedback-rewrite", { ...body, feedback: "  " })).status === 400);
  check("20-8 沒登入：401", (await call("POST", "/api/feedback-rewrite", body, "nobody")).status === 401);
  geminiReply = { feedback: "   " };
  const empty = await call("POST", "/api/feedback-rewrite", body);
  check("20-9 AI 回空的：502 請再按一次", empty.status === 502 && empty.json?.error?.includes("再按一次"), empty.text);
  geminiReply = { feedback: "好" };
  geminiStatus = 429;
  const q = await call("POST", "/api/feedback-rewrite", body);
  check("20-10 AI 額度滿：502 白話說明", q.status === 502 && q.json?.error?.includes("使用量"), q.text);
  geminiStatus = 200;
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
await dispose();
process.exit(fail ? 1 : 0);
