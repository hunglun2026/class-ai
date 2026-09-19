/**
 * 整合測試：標準答案檔存 R2、學生附件大小上限（v1.6.1）。
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
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls.push(JSON.parse(init.body));
    if (geminiMode === "real") return realFetch(input, init);
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
  await env.DB.prepare("INSERT INTO submissions VALUES (?, 'w1', ?, '學生', 'TURNED_IN', ?, ?, ?)")
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

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
await dispose();
process.exit(fail ? 1 : 0);
