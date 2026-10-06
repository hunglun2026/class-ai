import type { Env } from "../types";
import { ClassroomError, addLinkAttachment, patchGrades, returnSubmission } from "./classroom";
import { bytesToBase64 } from "./base64";
import { getValidAccessToken } from "./tokens";

/**
 * v1.22.0 一鍵發還（取代 v1.18.0 只送草稿分數）：寫正式分數 → 在學生繳交加評語連結 → 發還。
 * - 只發還「已完成批改」或「已鎖定」的，AI 建議分數永遠不會直接到學生手上
 * - 只限 classAI 自己建的作業（Google 只讓建立者寫分數、發還、加附件）
 * - 已發還、分數和評語都沒變的不重送；發還後又改的會再發一次（Classroom 允許）
 * - 評語 Google 不開放寫私人留言，所以放在 classAI 的評語頁，用連結附在學生的繳交上
 */

// 一次最多發還幾位：Cloudflare 免費方案一次請求最多 50 個對外呼叫，每位要 2～3 個（分數、連結、發還），
// 留幾個給換 token；前端看 remaining 自己接著送
export const PUSH_BATCH = 15;

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
  | {
      ok: true;
      pushed: number;
      failed: { name: string; reason: string }[];
      remaining: number;
      notConfirmed: number;
      // 評語連結加不上去（Google 不讓）：分數照樣發還，前端提醒老師評語要自己貼
      linkBlocked: boolean;
    }
  | { ok: false; status: 403 | 409; code: "need_write_scope" | "not_classai_work"; error: string };

const NEED_WRITE = "要先允許 classAI 寫入 Classroom 作業，才能把分數發還給學生";

// 128 位元隨機碼，網址安全的 base64
export function newFeedbackToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function feedbackUrl(env: Env, token: string): string {
  return `${env.APP_URL.replace(/\/$/, "")}/f/${token}`;
}

export async function pushConfirmedGrades(env: Env, teacherId: string, courseWorkId: string): Promise<PushResult> {
  if (!(await courseWorkCanWriteBack(env, courseWorkId))) {
    return {
      ok: false,
      status: 409,
      code: "not_classai_work",
      error: "這份作業是在 Classroom 建的，Google 不開放外部工具寫分數。下次在 classAI 出作業，就能一鍵發還",
    };
  }
  if (!(await teacherCanWrite(env, teacherId))) return { ok: false, status: 403, code: "need_write_scope", error: NEED_WRITE };

  const cw = await env.DB.prepare("SELECT course_id FROM coursework WHERE id = ?").bind(courseWorkId).first<{ course_id: string }>();
  if (!cw) return { ok: false, status: 409, code: "not_classai_work", error: "找不到這份作業" };

  const rows = await env.DB.prepare(
    `SELECT s.id, s.student_name, g.status, g.locked, COALESCE(g.final_score, g.ai_score) AS score,
       COALESCE(g.final_feedback, g.ai_feedback, '') AS feedback,
       r.feedback_token, r.returned_score, r.returned_feedback, r.returned_at, r.link_attached
     FROM submissions s LEFT JOIN grades g ON g.submission_id = s.id
     LEFT JOIN grade_returns r ON r.submission_id = s.id
     WHERE s.coursework_id = ? ORDER BY s.student_name`
  )
    .bind(courseWorkId)
    .all<{
      id: string;
      student_name: string;
      status: string;
      locked: number;
      score: number | null;
      feedback: string;
      feedback_token: string | null;
      returned_score: number | null;
      returned_feedback: string | null;
      returned_at: number | null;
      link_attached: number | null;
    }>();

  const confirmed = rows.results.filter((r) => (r.status === "confirmed" || r.locked === 1) && r.score != null);
  const todo = confirmed.filter((r) => r.returned_at == null || r.returned_score !== r.score || (r.returned_feedback ?? "") !== r.feedback);
  const notConfirmed = rows.results.length - confirmed.length;
  const batch = todo.slice(0, PUSH_BATCH);

  const accessToken = await getValidAccessToken(env, teacherId);
  const failed: { name: string; reason: string }[] = [];
  let pushed = 0;
  // 加連結被 Google 擋過一次就不再試，免得每位都多浪費一次呼叫
  let linkBlocked = false;
  const now = Math.floor(Date.now() / 1000);
  for (const r of batch) {
    try {
      await patchGrades(accessToken, cw.course_id, courseWorkId, r.id, r.score!);
    } catch (e) {
      // 授權過期（401）、Classroom 太忙（429）是整批的問題，交給全域錯誤處理：前端會請老師重新登入／稍後再試
      if (e instanceof ClassroomError && (e.status === 401 || e.status === 429)) throw e;
      // 第一位就 403：權限被撤掉，後面不用再試，請老師重新允許
      if (e instanceof ClassroomError && e.status === 403 && pushed === 0 && failed.length === 0) {
        await env.DB.prepare("UPDATE teacher_write_access SET can_write = 0, updated_at = ? WHERE teacher_id = ?").bind(now, teacherId).run();
        return { ok: false, status: 403, code: "need_write_scope", error: NEED_WRITE };
      }
      console.error("[return-grades]", r.id, e);
      const reason =
        e instanceof ClassroomError && e.status === 404
          ? "Classroom 上找不到這份繳交（可能被刪掉了）"
          : e instanceof ClassroomError && e.status === 400
            ? "Classroom 不收這個分數（請確認分數沒有小數位數過多或是負數）"
            : "發還失敗，請稍後再試";
      failed.push({ name: r.student_name, reason });
      continue;
    }

    const token = r.feedback_token ?? newFeedbackToken();
    let linked = r.link_attached === 1;
    if (!linked && !linkBlocked) {
      try {
        await addLinkAttachment(accessToken, cw.course_id, courseWorkId, r.id, feedbackUrl(env, token));
        linked = true;
      } catch (e) {
        if (e instanceof ClassroomError && (e.status === 401 || e.status === 429)) throw e;
        console.warn("[return-grades] 評語連結加不上去", r.id, e);
        linkBlocked = true;
      }
    }

    try {
      await returnSubmission(accessToken, cw.course_id, courseWorkId, r.id);
    } catch (e) {
      if (e instanceof ClassroomError && (e.status === 401 || e.status === 429)) throw e;
      // 已經發還過的（學生沒重交）再發一次 Google 可能回 400；正式分數已經寫上去，學生看得到新分數，當成功
      if (!(e instanceof ClassroomError && e.status === 400 && r.returned_at != null)) {
        console.error("[return-grades] return 失敗", r.id, e);
        failed.push({ name: r.student_name, reason: "分數寫上去了，但發還失敗（學生可能把作業收回了），請到 Classroom 看一下" });
        continue;
      }
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO grade_returns (submission_id, feedback_token, returned_score, returned_feedback, link_attached, returned_at, returned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET returned_score = excluded.returned_score, returned_feedback = excluded.returned_feedback,
           link_attached = MAX(grade_returns.link_attached, excluded.link_attached), returned_at = excluded.returned_at, returned_by = excluded.returned_by`
      ).bind(r.id, token, r.score, r.feedback, linked ? 1 : 0, now, teacherId),
      // 舊表一起更新：草稿分數也寫了同一個分數
      env.DB.prepare(
        `INSERT INTO grade_pushes (submission_id, pushed_score, pushed_at, pushed_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET pushed_score = excluded.pushed_score, pushed_at = excluded.pushed_at, pushed_by = excluded.pushed_by`
      ).bind(r.id, r.score, now, teacherId),
    ]);
    pushed++;
  }
  return { ok: true, pushed, failed, remaining: todo.length - batch.length, notConfirmed, linkBlocked };
}

// 學生評語頁用：只回作業名稱、分數、滿分、評語，不回姓名或作業內容
export async function getReturnedFeedback(env: Env, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT w.title, w.max_points, r.returned_score AS score, r.returned_feedback AS feedback, r.returned_at
     FROM grade_returns r JOIN submissions s ON s.id = r.submission_id JOIN coursework w ON w.id = s.coursework_id
     WHERE r.feedback_token = ? AND r.returned_at IS NOT NULL`
  )
    .bind(token)
    .first<{ title: string; max_points: number | null; score: number | null; feedback: string | null; returned_at: number }>();
}
