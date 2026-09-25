import { Hono, type Context } from "hono";
import type { Env, Variables } from "../types";
import { buildAuthUrl, decodeIdToken, exchangeCodeForTokens, missingScopes, WRITE_SCOPE } from "../lib/google-oauth";
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

// 登入完要回到哪一頁：只收站內路徑（/ 開頭、不是 //），避免被拿來導去別的網站
function safeReturnPath(p: string | undefined | null): string | null {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.length > 300) return null;
  return p;
}
const toB64Url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64Url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

// state 格式：<隨機>.<w或r>.<回到哪頁（base64url）>；整串存 cookie 比對，不會被竄改
function startLogin(c: Context<{ Bindings: Env; Variables: Variables }>, write: boolean) {
  const back = safeReturnPath(c.req.query("return"));
  const state = `${crypto.randomUUID()}.${write ? "w" : "r"}.${back ? toB64Url(back) : ""}`;
  c.header("Set-Cookie", oauthStateCookieHeader(c.env, state));
  // 這一跳絕對不能被瀏覽器留在快取裡：每次登入的 state 都不一樣，導回網址之後若有調整，
  // 舊的那一條會被重送，老師就會看到 Google 的 redirect_uri_mismatch，還以為是帳號有問題
  c.header("Cache-Control", "no-store");
  return c.redirect(buildAuthUrl(c.env, state, { write }));
}

authRoutes.get("/google/login", (c) => startLogin(c, false));
// v1.18.0：老師要在 classAI 出作業／送分數回 Classroom，多要一個可寫入的權限
authRoutes.get("/google/upgrade", (c) => startLogin(c, true));

// 權限網址太長，帶回前端時換成短代碼，登入頁再換成老師看得懂的名稱
const SCOPE_KEYS: Record<string, string> = {
  "https://www.googleapis.com/auth/classroom.courses.readonly": "courses",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly": "coursework",
  "https://www.googleapis.com/auth/classroom.rosters.readonly": "rosters",
  "https://www.googleapis.com/auth/drive.readonly": "drive",
};
const scopeKey = (scope: string) => SCOPE_KEYS[scope] ?? "other";

// 登入失敗一律導回前端登入頁，用代碼讓登入頁顯示白話說明＋重新登入按鈕，不丟一頁純文字錯誤給老師
type LoginError = "cancelled" | "expired" | "scopes" | "no_refresh" | "failed";
function backToLogin(c: Context<{ Bindings: Env; Variables: Variables }>, reason: LoginError, detail?: string) {
  c.header("Set-Cookie", clearOauthStateCookieHeader(), { append: true });
  c.header("Cache-Control", "no-store");
  const extra = detail ? `&missing=${encodeURIComponent(detail)}` : "";
  return c.redirect(`${c.env.APP_URL}/?login_error=${reason}${extra}`);
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
    const missing = missingScopes(granted);
    if (missing.length) {
      // 把少了哪幾項帶回登入頁，老師才知道要重新勾哪一個，不是只看到「有權限沒勾到」
      console.warn("[auth/callback] 少了權限", missing.join(","), "實際拿到", tokens.scope);
      return backToLogin(c, "scopes", missing.map(scopeKey).join(","));
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

    // 每次登入都照 Google 實際給的權限更新（include_granted_scopes 會把之前給過的也帶回來）
    const canWrite = granted.has(WRITE_SCOPE);
    await c.env.DB.prepare(
      `INSERT INTO teacher_write_access (teacher_id, can_write, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(teacher_id) DO UPDATE SET can_write = excluded.can_write, updated_at = excluded.updated_at`
    )
      .bind(profile.sub, canWrite ? 1 : 0, now)
      .run();

    const sessionId = await createSession(c.env, profile.sub);
    // append: true——上面已經設過一次 Set-Cookie（清 oauth_state），
    // 一般呼叫 c.header() 會覆蓋掉，兩個 cookie 都要送出去就必須用 append
    c.header("Set-Cookie", sessionCookieHeader(c.env, sessionId), { append: true });
    const [, mode, encodedBack] = returnedState!.split(".");
    let back: string | null = null;
    try {
      back = encodedBack ? safeReturnPath(fromB64Url(encodedBack)) : null;
    } catch {}
    // 要求寫入權限但老師在同意畫面沒勾：帶記號回去，頁面說明為什麼需要這一項
    const denied = mode === "w" && !canWrite ? `${back?.includes("?") ? "&" : "?"}write=denied` : "";
    return c.redirect(`${c.env.APP_URL}${back ?? "/"}${denied}`);
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

  const teacher = await c.env.DB.prepare(
    `SELECT t.id, t.email, t.name, t.picture, COALESCE(w.can_write, 0) AS canWrite
     FROM teachers t LEFT JOIN teacher_write_access w ON w.teacher_id = t.id WHERE t.id = ?`
  )
    .bind(teacherId)
    .first<{ canWrite: number }>();
  return c.json({ teacher: teacher ? { ...teacher, canWrite: teacher.canWrite === 1 } : null });
});
