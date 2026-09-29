import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { GradeError } from "../lib/gemini";
import { checkAiQuota, recordAiUse } from "../lib/usage";
import { REWRITE_ACTIONS, rewriteFeedback } from "../lib/feedback-rewrite";

// v1.21.0 評語一鍵調整：只改評語文字，不存檔（老師看過再按「先存起來」或「完成批改」），扣 1 次 AI
export const rewriteRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
rewriteRoutes.use("*", requireAuth);

const schema = z.object({
  action: z.enum(REWRITE_ACTIONS),
  feedback: z.string().trim().min(1, "評語是空的，沒東西可以改").max(3000, "評語太長了"),
  score: z.number().finite().min(0),
  maxPoints: z.number().finite().positive().max(1000),
});

rewriteRoutes.post("/", async (c) => {
  const teacherId = c.get("teacherId");
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "資料格式不對" }, 400);
  const quota = await checkAiQuota(c.env, teacherId);
  if (!quota.ok) {
    return c.json({ error: quota.reason === "daily" ? "今天的 AI 次數用完了，明天再試" : "按太快了，等一分鐘再試", code: "quota" }, 429);
  }
  const apiKeys = c.env.GEMINI_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  try {
    const { action, feedback, score, maxPoints } = parsed.data;
    const out = await rewriteFeedback(apiKeys, action, feedback, score, maxPoints);
    const remainingToday = await recordAiUse(c.env, teacherId);
    return c.json({ feedback: out, remainingToday });
  } catch (e) {
    console.error("[feedback-rewrite]", e);
    const quotaErr = e instanceof GradeError && e.kind === "quota";
    return c.json({ error: quotaErr ? "AI 使用量暫時滿了，等幾分鐘再試" : "AI 這次沒改好，請再按一次" }, 502);
  }
});
