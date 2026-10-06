// v1.22.0 學生看評語的頁面：classai.hunglun.com/f/<隨機碼>
// 老師按「發還給學生」時，這個連結會加在學生的 Classroom 繳交上（Google 不開放外部工具寫私人留言）。
// 在伺服器把 HTML 組好再送：學生不用登入、不用載前端程式，也就不用經過內測密碼閘（_middleware.js 放行 /f/）。
const DEFAULT_WORKER = "https://class-ai-worker.hunglun2026.workers.dev";

export async function onRequestGet({ params, env }) {
  const token = String(params.token || "");
  let data = null;
  if (/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    const target = (env.WORKER_ORIGIN || DEFAULT_WORKER).replace(/\/$/, "") + "/api/feedback/" + token;
    const res = await fetch(target).catch(() => null);
    if (res && res.ok) data = await res.json().catch(() => null);
  }
  return new Response(page(data), {
    status: data ? 200 : 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // 評語是學生個人的東西，不給搜尋引擎收錄
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtDate(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000 + 8 * 3600_000); // 台灣時間
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function page(data) {
  const body = data
    ? `<p class="label">作業</p>
  <h1>${esc(data.title)}</h1>
  <div class="score"><span class="num">${esc(data.score)}</span>${data.maxPoints != null ? `<span class="max">／${esc(data.maxPoints)} 分</span>` : "<span class=\"max\">分</span>"}</div>
  <p class="label">老師的評語</p>
  <div class="feedback">${esc(data.feedback) || "（老師沒有寫評語）"}</div>
  <p class="meta">${fmtDate(data.returnedAt)} 發還</p>`
    : `<h1>找不到這份評語</h1>
  <p class="meta">可能是連結不完整，或老師還沒發還。請回到 Classroom 重新點一次連結，還是不行就問老師。</p>`;
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>老師的評語</title>
<style>
  :root{--bg:#faf7f2;--card:#fff;--text:#2b2420;--muted:#7a6e66;--accent:#c2547a;--line:#eadfd6}
  @media (prefers-color-scheme: dark){:root{--bg:#1a1220;--card:#241a2c;--text:#f5e9ef;--muted:#c9a8bb;--accent:#e08ba8;--line:#3a2c42}}
  body{margin:0;background:var(--bg);color:var(--text);font-family:"Noto Sans TC",system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;
    line-height:1.7;padding:24px 16px}
  main{max-width:640px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px 20px}
  h1{font-size:22px;margin:0 0 12px}
  .label{font-size:13px;color:var(--muted);margin:16px 0 4px}
  .label:first-child{margin-top:0}
  .score{margin:4px 0 8px}
  .num{font-size:44px;font-weight:700;color:var(--accent)}
  .max{font-size:18px;color:var(--muted);margin-left:4px}
  .feedback{white-space:pre-wrap;word-break:break-word;font-size:16px;background:var(--bg);border-radius:12px;padding:14px 16px}
  .meta{font-size:13px;color:var(--muted);margin-top:16px}
  footer{max-width:640px;margin:12px auto 0;font-size:12px;color:var(--muted);text-align:center}
</style></head>
<body>
<main>
  ${body}
</main>
<footer>classAI 作業批改</footer>
</body></html>`;
}
