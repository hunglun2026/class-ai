// 把 classai.hunglun.com/oauth/* 原樣轉給後端 Worker（MCP OAuth 的 authorize/token/register/callback），
// 跟 functions/api/[[path]].js、functions/mcp/[[path]].js 同樣道理。
const DEFAULT_WORKER = "https://class-ai-worker.hunglun2026.workers.dev";

export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  const target = new URL((env.WORKER_ORIGIN || DEFAULT_WORKER).replace(/\/$/, "") + incoming.pathname + incoming.search);

  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.set("X-Forwarded-Host", incoming.host); // Worker 靠這個把 MCP 的 redirect_uri 寫成本網域

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
