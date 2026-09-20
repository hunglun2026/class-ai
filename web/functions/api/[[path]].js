// 把 classai.hunglun.com/api/* 原樣轉給後端 Worker。
//
// 為什麼要這一層：前端在 Pages、後端在 workers.dev 是兩個網域，登入 cookie 屬於「第三方 cookie」，
// Safari（iPad／iPhone／Mac）預設整個擋掉，老師會一直被踢回登入頁。經過這層轉送之後，
// 瀏覽器只看到 classai.hunglun.com 一個網域，cookie 變成第一方，Safari 就不會擋。
//
// 後端位置放環境變數 WORKER_ORIGIN（Pages 專案設定），沒設就退回公開的 workers.dev 網址。
const DEFAULT_WORKER = "https://class-ai-worker.hunglun2026.workers.dev";

export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  const target = new URL((env.WORKER_ORIGIN || DEFAULT_WORKER).replace(/\/$/, "") + incoming.pathname + incoming.search);

  // 照抄原請求，只換網址；Worker 需要知道老師原本是從哪個網域來的（CORS 與來源檢查用）
  const headers = new Headers(request.headers);
  headers.set("Origin", incoming.origin);
  headers.delete("Host");

  const res = await fetch(
    new Request(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual", // 登入導向要原樣回給瀏覽器，不能在這裡就跟著跳
    })
  );

  // Set-Cookie 等標頭原樣傳回；cookie 沒寫 Domain，瀏覽器就會記在 classai.hunglun.com 底下
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
