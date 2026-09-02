import type { Context, Next } from "hono";
import type { Env, Variables } from "./types";
import { getTeacherIdFromSession, readCookie } from "./lib/session";

export async function requireAuth(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const sessionId = readCookie(c.req.header("Cookie") ?? null, "session");
  const teacherId = await getTeacherIdFromSession(c.env, sessionId);
  if (!teacherId) {
    return c.json({ error: "未登入" }, 401);
  }
  c.set("teacherId", teacherId);
  await next();
}
