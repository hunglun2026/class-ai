import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { buildAuthUrl, decodeIdToken, exchangeCodeForTokens } from "../lib/google-oauth";
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

authRoutes.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("缺少 code 參數", 400);

  const expectedState = readCookie(c.req.header("Cookie") ?? null, "oauth_state");
  const returnedState = c.req.query("state");
  if (!expectedState || expectedState !== returnedState) {
    return c.text("登入驗證失敗（state 不符，可能是逾時或偽造的請求），請重新登入一次", 400);
  }
  c.header("Set-Cookie", clearOauthStateCookieHeader());

  try {
    const tokens = await exchangeCodeForTokens(c.env, code);
    if (!tokens.refresh_token) {
      // 使用者之前同意過，Google 這次沒再給 refresh_token；請他到 Google 帳號權限頁撤銷後重新登入
      return c.text("沒有取得 refresh_token，請到 https://myaccount.google.com/permissions 移除這個 App 的授權後重新登入一次", 400);
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
    console.error("[auth/callback]", e);
    return c.text(`登入失敗：${(e as Error).message}`, 500);
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
