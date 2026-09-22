import type { CalibrationExample } from "../types";

// 分差超過總分15%才算「老師真的改過」，避免把±1分的微調也算進去。
// 供 calibration.ts（可信度統計）與 submissions.ts（校準範例存取）共用同一個門檻。
export const CALIBRATION_EDIT_THRESHOLD = 0.15;

export function isMeaningfulEdit(aiScore: number, finalScore: number, maxPoints: number): boolean {
  if (maxPoints <= 0) return false;
  return Math.abs(aiScore - finalScore) / maxPoints > CALIBRATION_EDIT_THRESHOLD;
}

const MAX_EXCERPT_LENGTH = 600;
// 每份評分標準最多留幾筆範例：控制之後評分時塞進 prompt 的 token 量不會一直長大
const MAX_EXAMPLES_PER_RUBRIC = 8;
// 評分時最多拿幾筆最新的範例餵進 prompt
const EXAMPLES_PER_GRADE = 3;

/**
 * 老師確認分數且真的改過時呼叫：存一筆「這份評分標準」的校準範例，之後同一份評分標準
 * 再評分時當參考。超過上限就先刪最舊的一筆，範例內容不會無上限累積。
 * 跟 grading_calibration_logs（匿名聚合統計）不同用途，不影響那張表。
 */
export async function saveCalibrationExample(
  db: D1Database,
  params: {
    rubricId: string;
    studentContent: string;
    aiScore: number;
    aiFeedback: string | null;
    teacherFinalScore: number;
    teacherFinalFeedback: string | null;
    now: number;
  }
): Promise<void> {
  const excerpt = params.studentContent.trim();
  if (!excerpt) return; // 沒有可用的文字內容（例如純圖片/PDF 作業）就不存

  const countRow = await db
    .prepare("SELECT id FROM rubric_calibration_examples WHERE rubric_id = ? ORDER BY created_at ASC")
    .bind(params.rubricId)
    .all<{ id: string }>();
  const existing = countRow.results;
  if (existing.length >= MAX_EXAMPLES_PER_RUBRIC) {
    const toDelete = existing.slice(0, existing.length - MAX_EXAMPLES_PER_RUBRIC + 1);
    for (const row of toDelete) {
      await db.prepare("DELETE FROM rubric_calibration_examples WHERE id = ?").bind(row.id).run();
    }
  }

  await db
    .prepare(
      `INSERT INTO rubric_calibration_examples
         (id, rubric_id, student_excerpt, ai_score, ai_feedback, teacher_final_score, teacher_final_feedback, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      params.rubricId,
      excerpt.slice(0, MAX_EXCERPT_LENGTH),
      params.aiScore,
      params.aiFeedback,
      params.teacherFinalScore,
      params.teacherFinalFeedback,
      params.now
    )
    .run();
}

/** AI 評分前呼叫：拿這份評分標準最近幾筆老師校準過的範例，餵進 prompt 拿捏鬆緊。 */
export async function fetchCalibrationExamples(db: D1Database, rubricId: string): Promise<CalibrationExample[]> {
  const rows = await db
    .prepare(
      `SELECT student_excerpt, ai_score, teacher_final_score, teacher_final_feedback
       FROM rubric_calibration_examples WHERE rubric_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .bind(rubricId, EXAMPLES_PER_GRADE)
    .all<{ student_excerpt: string; ai_score: number; teacher_final_score: number; teacher_final_feedback: string | null }>();
  return rows.results.map((r) => ({
    studentExcerpt: r.student_excerpt,
    aiScore: r.ai_score,
    teacherFinalScore: r.teacher_final_score,
    teacherFinalFeedback: r.teacher_final_feedback,
  }));
}
