import type { Context, Next } from "hono";
import type { Env, Variables } from "./types";
import { getTeacherIdFromSession, readCookie } from "./lib/session";

export async function requireAuth(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const sessionId = readCookie(c.req.header("Cookie") ?? null, "session");
  const teacherId = await getTeacherIdFromSession(c.env, sessionId);
  if (!teacherId) {
    // code 讓前端認得出「登入過期」，統一跳回登入頁，不是只在畫面上顯示一行字
    return c.json({ error: "登入已過期，請重新登入", code: "not_logged_in" }, 401);
  }
  c.set("teacherId", teacherId);
  await next();
}
