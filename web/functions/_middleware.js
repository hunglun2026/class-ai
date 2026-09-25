// 內測期間的密碼閘：正式商用前不想讓網址被隨意打開就先擋一層。
// 密碼放在 Pages 專案的環境變數 SITE_PASSWORD（加密），沒設定就直接放行。
// 只有密碼欄位（自訂頁面，不用瀏覽器原生 Basic Auth 彈窗，因為那個彈窗一定會多一個
// 用不到、也沒辦法拿掉或預填的「使用者名稱」欄位）。
// 要拿掉這層保護：把 SITE_PASSWORD 環境變數刪掉即可。
const COOKIE_NAME = "ca_auth";

const DEFAULT_WORKER = "https://class-ai-worker.hunglun2026.workers.dev";

export async function onRequest(context) {
  const { request, env, next } = context;

  // MCP 用戶端（Claude 連接器等）先讀 /.well-known/oauth-* 找登入入口，這兩個設定檔由 Worker 產生，
  // 不轉過去的話會拿到密碼頁或前端首頁，連接器就找不到怎麼登入
  const url = new URL(request.url);
  if (url.pathname.startsWith("/.well-known/oauth-")) {
    const headers = new Headers(request.headers);
    headers.delete("Host");
    headers.set("X-Forwarded-Host", url.host);
    const target = (env.WORKER_ORIGIN || DEFAULT_WORKER).replace(/\/$/, "") + url.pathname + url.search;
    const res = await fetch(target, { headers });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  const expected = env.SITE_PASSWORD;
  if (!expected) return next();

  // /api/*、/mcp/* 不經過密碼閘：那是給程式呼叫的，而且 Google 登入完會直接導回
  // callback 網址，那個請求不會帶密碼 cookie，擋下來登入就壞了。
  // 這些路徑本來就要 Google 登入才拿得到資料（只有 /health 與 /api/auth/* 是公開的）
  const path = new URL(request.url).pathname;
  if (path === "/mcp" || path.startsWith("/api/") || path.startsWith("/mcp/") || path.startsWith("/oauth/")) return next();

  const cookies = request.headers.get("Cookie") || "";
  const authed = cookies.split(";").some((c) => {
    const i = c.indexOf("=");
    if (i === -1) return false;
    return c.slice(0, i).trim() === COOKIE_NAME && c.slice(i + 1).trim() === expected;
  });
  if (authed) return next();

  if (request.method === "POST") {
    // 不是表單送來的（例如 JSON）formData() 會丟例外變成 500，當成密碼錯處理
    const form = await request.formData().catch(() => null);
    const pass = form?.get("password") || "";
    if (pass === expected) {
      const headers = new Headers({ Location: "/" });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
      );
      return new Response(null, { status: 302, headers });
    }
    return new Response(loginPage(true), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(loginPage(false), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function loginPage(wrong) {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>classAI 內測密碼</title>
<style>
  body{font-family:system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;
    background:#1a1220;color:#f5e9ef;display:flex;align-items:center;justify-content:center;
    min-height:100vh;margin:0;padding:16px}
  form{background:#241a2c;padding:28px 24px;border-radius:16px;width:100%;max-width:320px;
    box-shadow:0 8px 24px rgba(0,0,0,.3)}
  h1{font-size:20px;margin:0 0 6px}
  p.hint{font-size:13px;color:#c9a8bb;margin:0 0 20px}
  label{display:block;font-size:14px;margin-bottom:8px;color:#e8d4de}
  input{width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border-radius:10px;
    border:1px solid #4a3a52;background:#2e2136;color:#f5e9ef;margin-bottom:16px}
  input:focus{outline:2px solid #e08ba8}
  button{width:100%;font-size:16px;padding:10px;min-height:40px;border-radius:999px;border:none;
    background:#e08ba8;color:#1a1220;font-weight:600;cursor:pointer}
  .err{color:#ff9db0;font-size:13px;margin:-8px 0 16px}
</style></head>
<body>
<form method="POST">
  <h1>classAI 內測中</h1>
  <p class="hint">請輸入密碼繼續</p>
  ${wrong ? '<p class="err">密碼錯誤，請再試一次</p>' : ""}
  <label for="password">密碼</label>
  <input id="password" name="password" type="password" autofocus>
  <button type="submit">進入</button>
</form>
</body></html>`;
}
