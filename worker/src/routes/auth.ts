import { Hono, type Context } from "hono";
import type { Env, Variables } from "../types";
import { buildAuthUrl, decodeIdToken, exchangeCodeForTokens, REQUIRED_SCOPES } from "../lib/google-oauth";
import { encrypt } from "../lib/crypto";
import {
  createSession,
  destroySession,
  getTeacherIdFromSession,
  readCookie,
  sessionCookieHeader,
  clearCookieHeader,
  oauthStateCookieHeader,
  clearOauthStateCookieHeader,
} from "../lib/session";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

authRoutes.get("/google/login", (c) => {
  const state = crypto.randomUUID();
  c.header("Set-Cookie", oauthStateCookieHeader(c.env, state));
  return c.redirect(buildAuthUrl(c.env, state));
});

// 登入失敗一律導回前端登入頁，用代碼讓登入頁顯示白話說明＋重新登入按鈕，不丟一頁純文字錯誤給老師
type LoginError = "cancelled" | "expired" | "scopes" | "no_refresh" | "failed";
function backToLogin(c: Context<{ Bindings: Env; Variables: Variables }>, reason: LoginError) {
  c.header("Set-Cookie", clearOauthStateCookieHeader(), { append: true });
  return c.redirect(`${c.env.APP_URL}/?login_error=${reason}`);
}

authRoutes.get("/google/callback", async (c) => {
  // 老師在 Google 同意畫面按「取消」：Google 帶 error=access_denied 回來、沒有 code
  if (c.req.query("error")) return backToLogin(c, "cancelled");
  const code = c.req.query("code");
  if (!code) return backToLogin(c, "failed");

  const expectedState = readCookie(c.req.header("Cookie") ?? null, "oauth_state");
  const returnedState = c.req.query("state");
  if (!expectedState || expectedState !== returnedState) {
    // 最常見是登入頁開太久（state cookie 10 分鐘過期），或按了瀏覽器上一頁重送
    return backToLogin(c, "expired");
  }
  c.header("Set-Cookie", clearOauthStateCookieHeader());

  try {
    const tokens = await exchangeCodeForTokens(c.env, code);
    // Google 同意畫面可以逐項取消勾選；少勾一項，登入會成功但之後讀課程／檔案全部失敗，要在這裡就攔下
    const granted = new Set((tokens.scope ?? "").split(" "));
    if (REQUIRED_SCOPES.some((s) => !granted.has(s))) {
      return backToLogin(c, "scopes");
    }
    if (!tokens.refresh_token) {
      // 使用者之前同意過，Google 這次沒再給 refresh_token；請他到 Google 帳號權限頁撤銷後重新登入
      return backToLogin(c, "no_refresh");
    }
    const profile = decodeIdToken(tokens.id_token);
    const now = Math.floor(Date.now() / 1000);
    const encryptedRefresh = await encrypt(c.env.SESSION_SECRET, tokens.refresh_token);

    await c.env.DB.prepare(
      `INSERT INTO teachers (id, email, name, picture, refresh_token, access_token, access_token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email, name = excluded.name, picture = excluded.picture,
         refresh_token = excluded.refresh_token, access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at, updated_at = excluded.updated_at`
    )
      .bind(
        profile.sub,
        profile.email,
        profile.name,
        profile.picture ?? null,
        encryptedRefresh,
        tokens.access_token,
        now + tokens.expires_in,
        now,
        now
      )
      .run();

    const sessionId = await createSession(c.env, profile.sub);
    // append: true——上面已經設過一次 Set-Cookie（清 oauth_state），
    // 一般呼叫 c.header() 會覆蓋掉，兩個 cookie 都要送出去就必須用 append
    c.header("Set-Cookie", sessionCookieHeader(c.env, sessionId), { append: true });
    return c.redirect(c.env.APP_URL);
  } catch (e) {
    // 詳細原因只進 log，不把 Google 的原始錯誤回給老師
    console.error("[auth/callback]", e);
    return backToLogin(c, "failed");
  }
});

authRoutes.post("/logout", async (c) => {
  const sessionId = readCookie(c.req.header("Cookie") ?? null, "session");
  if (sessionId) await destroySession(c.env, sessionId);
  c.header("Set-Cookie", clearCookieHeader(c.env));
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const sessionId = readCookie(c.req.header("Cookie") ?? null, "session");
  const teacherId = await getTeacherIdFromSession(c.env, sessionId);
  if (!teacherId) return c.json({ teacher: null });

  const teacher = await c.env.DB.prepare("SELECT id, email, name, picture FROM teachers WHERE id = ?")
    .bind(teacherId)
    .first();
  return c.json({ teacher });
});
