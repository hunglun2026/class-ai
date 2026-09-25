import { Hono } from "hono";
import { z } from "zod";
import type { Env, Rubric, Variables } from "../types";
import { requireAuth } from "../middleware";
import { DEFAULT_STYLE, loadFeedbackStyle, MAX_SAMPLE_CHARS, MAX_SAMPLES } from "../lib/feedback-style";
import { gradeSubmission, GradeError } from "../lib/gemini";
import { checkAiQuota, recordAiUse } from "../lib/usage";

/** v1.19.0 評語風格：每位老師一套，套用在他所有的 AI 評分（含背景自動預批） */
export const styleRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
styleRoutes.use("*", requireAuth);

const styleSchema = z.object({
  format: z.enum(["three", "two", "one"]),
  tone: z.enum(["warm", "concise", "lively"]),
  length: z.enum(["short", "medium", "long"]),
  samples: z
    .array(z.string().max(MAX_SAMPLE_CHARS, `每則範例評語最多 ${MAX_SAMPLE_CHARS} 字`))
    .max(MAX_SAMPLES, `範例評語最多 ${MAX_SAMPLES} 則`)
    .transform((a) => a.map((t) => t.trim()).filter(Boolean)),
});

styleRoutes.get("/", async (c) => {
  const style = await loadFeedbackStyle(c.env, c.get("teacherId"));
  const saved = await c.env.DB.prepare("SELECT 1 FROM teacher_feedback_style WHERE teacher_id = ?").bind(c.get("teacherId")).first();
  return c.json({ style, isDefault: !saved });
});

styleRoutes.put("/", async (c) => {
  const parsed = styleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "資料格式不對" }, 400);
  const s = parsed.data;
  await c.env.DB.prepare(
    `INSERT INTO teacher_feedback_style (teacher_id, format, tone, length, samples_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(teacher_id) DO UPDATE SET format = excluded.format, tone = excluded.tone, length = excluded.length,
       samples_json = excluded.samples_json, updated_at = excluded.updated_at`
  )
    .bind(c.get("teacherId"), s.format, s.tone, s.length, JSON.stringify(s.samples), Math.floor(Date.now() / 1000))
    .run();
  return c.json({ style: s });
});

// 試寫：用內建的範例作答（不是真的學生資料），照老師目前畫面上的設定（還沒存也可以）寫一則評語
const SAMPLE_RUBRIC: Rubric = {
  id: "preview",
  courseworkId: "preview",
  mode: "freetext",
  instructions: "看學生有沒有說明四季形成的原因（地軸傾斜、太陽直射角度、白天長短），有沒有迷思概念。",
  maxPoints: 10,
};
const SAMPLE_ANSWER =
  "四季是因為地球繞太陽轉，夏天的時候地球比較靠近太陽，所以比較熱；冬天離太陽比較遠，所以比較冷。還有地球是斜的，所以太陽照下來的角度會不一樣。";

styleRoutes.post("/preview", async (c) => {
  const teacherId = c.get("teacherId");
  const parsed = styleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "資料格式不對" }, 400);
  const quota = await checkAiQuota(c.env, teacherId);
  if (!quota.ok) {
    return c.json({ error: quota.reason === "daily" ? "今天的 AI 次數用完了，明天再試" : "按太快了，等一分鐘再試", code: "quota" }, 429);
  }
  const apiKeys = c.env.GEMINI_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  try {
    const { result } = await gradeSubmission(apiKeys, SAMPLE_RUBRIC, SAMPLE_ANSWER, [], [], undefined, { ...DEFAULT_STYLE, ...parsed.data });
    const remainingToday = await recordAiUse(c.env, teacherId);
    return c.json({ sampleAnswer: SAMPLE_ANSWER, feedback: result.feedback, score: result.score, remainingToday });
  } catch (e) {
    console.error("[style/preview]", e);
    const quotaErr = e instanceof GradeError && e.kind === "quota";
    return c.json({ error: quotaErr ? "AI 使用量暫時滿了，等幾分鐘再試" : "AI 這次沒寫出來，請再按一次" }, 502);
  }
});
