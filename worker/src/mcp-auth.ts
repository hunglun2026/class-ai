import { Hono } from "hono";
import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, Variables } from "./types";
import { decodeIdToken } from "./lib/google-oauth";
import { handleMcpRequest } from "./mcp-server";

// MCP 這條路的登入，跟網頁登入（src/routes/auth.ts）是分開的兩條路，但共用同一組 Google
// OAuth client、同一張 teachers 表。差別：MCP 只要求 openid/email/profile 確認「這是誰」，
// 不重新要求 Classroom 權限——真正呼叫 Classroom API 時，工具內部用 getValidAccessToken()
// 讀這位老師網頁登入時已經存好的 refresh_token，所以 MCP 不是新的教師註冊入口，
// 老師要先在網頁登入過 classAI 一次，MCP 才連得上。
const MCP_SCOPES = ["openid", "email"];

// 用「這次請求打到的網址」當 redirect_uri 的網域，不是寫死 env.APP_URL：本機開發時
// Inspector 直接連 localhost:8787（沒有 Pages 那層轉送），正式環境走 classai.hunglun.com
// （Pages 把 /oauth/* 轉給這支 Worker，見 web/functions/oauth/[[path]].js）。兩個網址都要先在
// Google Console 的 OAuth client 加進 Authorized redirect URIs，跟現有網頁登入的兩筆並列。
function mcpRedirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/oauth/callback`;
}

export const mcpAuthRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// 老師的 MCP client（例如 Claude Desktop）發起授權時，workers-oauth-provider 會先攔截、
// 驗證 client/redirect_uri/PKCE，再把處理權交給這裡（因為要不要登入、怎麼登入是應用程式自己的事）。
mcpAuthRoutes.get("/authorize", async (c) => {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectUri) {
      const redirect = new URL(e.redirectUri);
      redirect.searchParams.set("error", e.code);
      redirect.searchParams.set("error_description", e.description);
      if (e.state) redirect.searchParams.set("state", e.state);
      return c.redirect(redirect.toString(), 302);
    }
    return c.text("授權請求格式不對，請重新從 MCP client 連線一次", 400);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return c.text("不認得這個 MCP client", 400);

  // 用一組短期一次性代碼把 oauthRequest 存進 KV，等 Google callback 回來時取回——
  // 不用 cookie 是因為這一段是 MCP client（例如 Claude Desktop 內嵌瀏覽器）發起的，
  // 不保證跟一般網頁瀏覽器一樣的 cookie 行為，KV 比較可靠。
  const mcpState = crypto.randomUUID();
  await c.env.SESSIONS.put(`mcp_auth:${mcpState}`, JSON.stringify(oauthRequest), { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: mcpRedirectUri(c.req.url),
    response_type: "code",
    scope: MCP_SCOPES.join(" "),
    access_type: "online", // 只用來認身分，不需要 refresh_token
    prompt: "select_account",
    state: mcpState,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
});

mcpAuthRoutes.get("/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (c.req.query("error") || !state || !code) return c.text("登入取消或失敗，請重新從 MCP client 連線一次", 400);

  const stored = await c.env.SESSIONS.get(`mcp_auth:${state}`);
  if (!stored) return c.text("這個登入連結已經過期（超過 10 分鐘），請重新從 MCP client 連線一次", 400);
  await c.env.SESSIONS.delete(`mcp_auth:${state}`);
  const oauthRequest = JSON.parse(stored) as AuthRequest;

  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: mcpRedirectUri(c.req.url),
      grant_type: "authorization_code",
    }),
  });
  if (!tr.ok) return c.text("跟 Google 交換權杖失敗，請重新連線一次", 502);
  const tokens = await tr.json<{ id_token: string }>();
  const profile = decodeIdToken(tokens.id_token);

  // 這是關鍵防呆：MCP 不是新的教師註冊入口，一定要先在網頁登入過 classAI，teachers 表才會有這筆資料
  const teacher = await c.env.DB.prepare("SELECT id FROM teachers WHERE id = ?").bind(profile.sub).first<{ id: string }>();
  if (!teacher) {
    return c.text(
      `這個 Google 帳號（${profile.email}）還沒用過 classAI 網頁版。請先到 ${c.env.APP_URL} 用這個帳號登入一次，再回來連線 MCP。`,
      403
    );
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: profile.sub,
    metadata: { teacherEmail: profile.email },
    scope: oauthRequest.scope,
    props: { teacherId: profile.sub },
  });
  return c.redirect(redirectTo, 302);
});

// 掛在 OAuthProvider 的 apiHandler：這裡收到的請求已經被驗證過 Bearer token，
// c.executionCtx 帶著 authorize 時存進去的 props（見上面 completeAuthorization 的 props）。
export const mcpApiApp = new Hono<{ Bindings: Env; Variables: Variables }>();
mcpApiApp.all("/mcp", async (c) => {
  const props = (c.executionCtx as unknown as { props?: { teacherId: string } }).props;
  if (!props?.teacherId) return c.text("未授權", 401);
  return handleMcpRequest(c.req.raw, c.env, props.teacherId);
});
