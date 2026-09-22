import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { CALIBRATION_EDIT_THRESHOLD } from "../lib/calibration";

export const calibrationRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
calibrationRoutes.use("*", requireAuth);

// 老師修改AI分數的比例——商業化第一步要驗證的指標（目標：低於15~20%才算AI評分可信）。
// 資料完全匿名（見 migration 0005），任何登入的老師都能看整體聚合數字，看不到任何個人資料。
calibrationRoutes.get("/summary", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT mode, max_points, ai_score, teacher_final_score, score_diff FROM grading_calibration_logs`
  ).all<{ mode: string; max_points: number; ai_score: number; teacher_final_score: number; score_diff: number }>();

  const list = rows.results;
  const total = list.length;
  if (total === 0) {
    return c.json({ total: 0, editRatePercent: null, avgScoreDiffPercent: null, byMode: {} });
  }

  const EDIT_THRESHOLD = CALIBRATION_EDIT_THRESHOLD;
  let edited = 0;
  let diffPercentSum = 0;
  const byMode: Record<string, { total: number; edited: number }> = {};

  for (const row of list) {
    const diffPercent = row.max_points > 0 ? row.score_diff / row.max_points : 0;
    diffPercentSum += diffPercent;
    const isEdited = diffPercent > EDIT_THRESHOLD;
    if (isEdited) edited += 1;
    const bucket = (byMode[row.mode] ??= { total: 0, edited: 0 });
    bucket.total += 1;
    if (isEdited) bucket.edited += 1;
  }

  return c.json({
    total,
    editRatePercent: Math.round((edited / total) * 1000) / 10,
    avgScoreDiffPercent: Math.round((diffPercentSum / total) * 1000) / 10,
    byMode: Object.fromEntries(
      Object.entries(byMode).map(([mode, v]) => [mode, { total: v.total, editRatePercent: Math.round((v.edited / v.total) * 1000) / 10 }])
    ),
  });
});
