import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { checkAiQuota } from "../lib/usage";

export const usageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
usageRoutes.use("*", requireAuth);

// 批改頁顯示「今天還可以讓 AI 評 N 份」用
usageRoutes.get("/", async (c) => {
  const q = await checkAiQuota(c.env, c.get("teacherId"));
  return c.json({ usedToday: q.usedToday, dailyLimit: q.dailyLimit, remainingToday: q.remainingToday });
});
