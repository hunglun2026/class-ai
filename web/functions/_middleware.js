// 內測期間的密碼閘：正式商用前不想讓網址被隨意打開就先擋一層。
// 密碼放在 Pages 專案的環境變數 SITE_PASSWORD（加密），沒設定就直接放行。
// 帳號欄位隨便填，只認密碼。要拿掉這層保護：把 SITE_PASSWORD 環境變數刪掉即可。
export async function onRequest(context) {
  const { request, env, next } = context;
  const expected = env.SITE_PASSWORD;
  if (!expected) return next();

  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = "";
    }
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (pass === expected) return next();
  }

  return new Response("這個工具還在內測，請輸入密碼。", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="class-ai 內測", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
