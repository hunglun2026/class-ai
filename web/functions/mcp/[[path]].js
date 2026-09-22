// 把 classai.hunglun.com/mcp/* 原樣轉給後端 Worker，跟 functions/api/[[path]].js 同樣道理
// （前端 Pages、後端 workers.dev 是兩個網域）。MCP 這條路本身不靠 cookie（用 Bearer token），
// 但沿用同一個網域可以只在 Google Console 加一筆新的 redirect URI，不用另外管一個網域。
const DEFAULT_WORKER = "https://class-ai-worker.hunglun2026.workers.dev";

export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  const target = new URL((env.WORKER_ORIGIN || DEFAULT_WORKER).replace(/\/$/, "") + incoming.pathname + incoming.search);

  const headers = new Headers(request.headers);
  headers.delete("Host");

  const res = await fetch(
    new Request(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    })
  );

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
