import type { Env } from "../types";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 天

export async function createSession(env: Env, teacherId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await env.SESSIONS.put(`session:${sessionId}`, teacherId, { expirationTtl: SESSION_TTL_SECONDS });
  return sessionId;
}

export async function getTeacherIdFromSession(env: Env, sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  return env.SESSIONS.get(`session:${sessionId}`);
}

export async function destroySession(env: Env, sessionId: string): Promise<void> {
  await env.SESSIONS.delete(`session:${sessionId}`);
}

export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

// 前端（class-ai.pages.dev）跟後端 API（class-ai-worker.hunglun2026.workers.dev）是不同網域，
// 前端用 fetch 帶這個 cookie 屬於跨網域請求，SameSite=Lax 會被瀏覽器擋掉不送出，
// 導致登入完成後前端讀不到已登入狀態、被導回登入頁循環。正式環境要用 SameSite=None
// （瀏覽器規定 SameSite=None 一定要搭配 Secure，本機 http 開發環境沒有 https 用不了，維持 Lax 即可，
// 反正本機前後端都是 localhost，屬於同一個 site，Lax 不會擋）。
function sessionCookieAttrs(env: Env): string {
  return env.ENVIRONMENT === "production" ? "SameSite=None; Secure" : "SameSite=Lax";
}

export function sessionCookieHeader(env: Env, sessionId: string): string {
  return `session=${sessionId}; Path=/; HttpOnly; ${sessionCookieAttrs(env)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearCookieHeader(env: Env): string {
  return `session=; Path=/; HttpOnly; ${sessionCookieAttrs(env)}; Max-Age=0`;
}

// OAuth state 防 CSRF：登入導去 Google 前先把 state 存一份短效 cookie，
// callback 回來時比對 query 的 state 跟這份 cookie 是否一致，不一致就拒絕
// （防止有人拿一組自己準備好的 code 誘騙使用者的瀏覽器打我們的 callback，冒名登入別人的帳號）。
const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 分鐘，夠使用者跑完 Google 登入畫面

export function oauthStateCookieHeader(env: Env, state: string): string {
  const secure = env.ENVIRONMENT === "production" ? "; Secure" : "";
  return `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_SECONDS}${secure}`;
}

export function clearOauthStateCookieHeader(): string {
  return `oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
