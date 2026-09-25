import type { Env } from "../types";
import { ClassroomError, patchDraftGrade } from "./classroom";
import { getValidAccessToken } from "./tokens";

/**
 * v1.18.0 把老師確認過的分數送回 Classroom（草稿分數，學生看不到，老師在 Classroom 按「發還」才算數）。
 * - 只送「已完成批改」或「已鎖定」的，AI 建議分數永遠不會直接進 Classroom
 * - 只送 classAI 自己建的作業（Google 只讓建立者寫分數）
 * - 已經送過、分數沒變的不重送；送過又改分的會再送
 */

// 一次最多送幾位：Cloudflare 免費方案一次請求最多 50 個對外呼叫，留幾個給換 token；前端看 remaining 自己接著送
export const PUSH_BATCH = 40;

export async function teacherCanWrite(env: Env, teacherId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT can_write FROM teacher_write_access WHERE teacher_id = ?")
    .bind(teacherId)
    .first<{ can_write: number }>();
  return row?.can_write === 1;
}

export async function courseWorkCanWriteBack(env: Env, courseWorkId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT can_write_back FROM coursework_writeback WHERE coursework_id = ?")
    .bind(courseWorkId)
    .first<{ can_write_back: number }>();
  return row?.can_write_back === 1;
}

export type PushResult =
  | { ok: true; pushed: number; failed: { name: string; reason: string }[]; remaining: number; notConfirmed: number }
  | { ok: false; status: 403 | 409; code: "need_write_scope" | "not_classai_work"; error: string };

const NEED_WRITE = "要先允許 classAI 寫入 Classroom 作業，才能把分數送回去";

export async function pushConfirmedGrades(env: Env, teacherId: string, courseWorkId: string): Promise<PushResult> {
  if (!(await courseWorkCanWriteBack(env, courseWorkId))) {
    return {
      ok: false,
      status: 409,
      code: "not_classai_work",
      error: "這份作業是在 Classroom 建的，Google 不開放外部工具寫分數。下次在 classAI 出作業，就能一鍵送回",
    };
  }
  if (!(await teacherCanWrite(env, teacherId))) return { ok: false, status: 403, code: "need_write_scope", error: NEED_WRITE };

  const cw = await env.DB.prepare("SELECT course_id FROM coursework WHERE id = ?").bind(courseWorkId).first<{ course_id: string }>();
  if (!cw) return { ok: false, status: 409, code: "not_classai_work", error: "找不到這份作業" };

  const rows = await env.DB.prepare(
    `SELECT s.id, s.student_name, g.status, g.locked, COALESCE(g.final_score, g.ai_score) AS score, p.pushed_score
     FROM submissions s LEFT JOIN grades g ON g.submission_id = s.id
     LEFT JOIN grade_pushes p ON p.submission_id = s.id
     WHERE s.coursework_id = ? ORDER BY s.student_name`
  )
    .bind(courseWorkId)
    .all<{ id: string; student_name: string; status: string; locked: number; score: number | null; pushed_score: number | null }>();

  const confirmed = rows.results.filter((r) => (r.status === "confirmed" || r.locked === 1) && r.score != null);
  const todo = confirmed.filter((r) => r.pushed_score !== r.score);
  const notConfirmed = rows.results.length - confirmed.length;
  const batch = todo.slice(0, PUSH_BATCH);

  const accessToken = await getValidAccessToken(env, teacherId);
  const failed: { name: string; reason: string }[] = [];
  let pushed = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const r of batch) {
    try {
      await patchDraftGrade(accessToken, cw.course_id, courseWorkId, r.id, r.score!);
      await env.DB.prepare(
        `INSERT INTO grade_pushes (submission_id, pushed_score, pushed_at, pushed_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET pushed_score = excluded.pushed_score, pushed_at = excluded.pushed_at, pushed_by = excluded.pushed_by`
      )
        .bind(r.id, r.score, now, teacherId)
        .run();
      pushed++;
    } catch (e) {
      // 授權過期（401）、Classroom 太忙（429）是整批的問題，交給全域錯誤處理：前端會請老師重新登入／稍後再試
      if (e instanceof ClassroomError && (e.status === 401 || e.status === 429)) throw e;
      // 第一位就 403：權限被撤掉，後面不用再試，請老師重新允許
      if (e instanceof ClassroomError && e.status === 403 && pushed === 0 && failed.length === 0) {
        await env.DB.prepare("UPDATE teacher_write_access SET can_write = 0, updated_at = ? WHERE teacher_id = ?").bind(now, teacherId).run();
        return { ok: false, status: 403, code: "need_write_scope", error: NEED_WRITE };
      }
      console.error("[push-grades]", r.id, e);
      const reason =
        e instanceof ClassroomError && e.status === 404
          ? "Classroom 上找不到這份繳交（可能被刪掉了）"
          : e instanceof ClassroomError && e.status === 400
            ? "Classroom 不收這個分數（請確認分數沒有小數位數過多或是負數）"
            : "送出失敗，請稍後再試";
      failed.push({ name: r.student_name, reason });
    }
  }
  return { ok: true, pushed, failed, remaining: todo.length - batch.length, notConfirmed };
}
