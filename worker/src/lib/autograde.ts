import type { Env } from "../types";
import { getValidAccessToken } from "./tokens";
import { syncCourseWorkSubmissions } from "./sync";
import { gradeOneSubmission } from "./grade";
import { GoogleAuthExpiredError } from "./google-oauth";
import { ClassroomError } from "./classroom";

/**
 * 背景自動預批改（v1.17.0，Cron 每 10 分鐘）：老師打開時批改已經在等，不用守著畫面。
 *
 * 接手哪些作業：autograde_watch 裡還沒到期、有評分標準的（老師存評分標準或打開批改頁時登記 21 天）。
 * 評哪些學生：已繳交、最後繳交滿 10 分鐘沒再變動（學生連續重交不重複燒額度），且
 *   - 還沒評過；或
 *   - 學生重交、分數仍是 AI 建議（老師沒動過）→ 重評
 *   老師改過或確認鎖定的一律不動，批改頁「重交」篩選會提醒老師自己決定。
 * AI 評不了的（讀不到附件、只交連結、被擋、連續失敗 3 次）寫進 submissions.autograde_error，
 * 學生重交前不再重試，老師在批改頁看到「需要你自己批」。
 */
export const STABLE_S = 600;
const MAX_WATCHES_PER_RUN = 20;
const DEFAULT_GRADES_PER_RUN = 15;
const CONCURRENCY = 3;
export const MAX_ATTEMPTS = 3;

export interface AutoGradeSummary {
  watched: number;
  synced: number;
  graded: number;
  needsTeacher: number;
  retryLater: number;
  errors: string[];
}

export async function runAutoGrade(env: Env, nowMs = Date.now()): Promise<AutoGradeSummary> {
  const now = Math.floor(nowMs / 1000);
  const summary: AutoGradeSummary = { watched: 0, synced: 0, graded: 0, needsTeacher: 0, retryLater: 0, errors: [] };

  // 要重新登入的老師（auth_expired）先跳過，他打開批改頁時 watchCourseWork 會清掉這個錯誤
  const watches = await env.DB.prepare(
    `SELECT w.coursework_id, w.course_id, w.teacher_id FROM autograde_watch w
     JOIN rubrics r ON r.coursework_id = w.coursework_id
     WHERE w.watch_until > ? AND (w.last_error IS NULL OR w.last_error != 'auth_expired')
     ORDER BY COALESCE(w.last_synced_at, 0) LIMIT ?`
  )
    .bind(now, MAX_WATCHES_PER_RUN)
    .all<{ coursework_id: string; course_id: string; teacher_id: string }>();
  summary.watched = watches.results.length;
  if (!watches.results.length) return summary;

  // 1. 同步：一份一份來，同一位老師授權失效就不用再試他的其他作業
  const expiredTeachers = new Set<string>();
  const synced: string[] = [];
  for (const w of watches.results) {
    if (expiredTeachers.has(w.teacher_id)) continue;
    try {
      const token = await getValidAccessToken(env, w.teacher_id);
      await syncCourseWorkSubmissions(env, token, w.course_id, w.coursework_id);
      await env.DB.prepare("UPDATE autograde_watch SET last_synced_at = ?, last_error = NULL WHERE coursework_id = ?")
        .bind(now, w.coursework_id)
        .run();
      synced.push(w.coursework_id);
    } catch (e) {
      const authLost = e instanceof GoogleAuthExpiredError || (e instanceof ClassroomError && e.status === 401);
      if (authLost) expiredTeachers.add(w.teacher_id);
      // Classroom 說作業不見了（刪除／封存）：不用再輪詢
      const gone = e instanceof ClassroomError && e.status === 404;
      const code = authLost ? "auth_expired" : e instanceof ClassroomError ? `classroom_${e.status}` : "sync_failed";
      await env.DB.prepare(
        `UPDATE autograde_watch SET last_error = ?, last_synced_at = ?${gone ? ", watch_until = ?" : ""} WHERE coursework_id = ?`
      )
        .bind(...(gone ? [code, now, now, w.coursework_id] : [code, now, w.coursework_id]))
        .run();
      summary.errors.push(`${w.coursework_id}: ${code}`);
      console.warn("[autograde] 同步失敗", w.coursework_id, code, e);
    }
  }
  summary.synced = synced.length;
  if (!synced.length) return summary;

  // 2. 挑要評的學生
  const placeholders = synced.map(() => "?").join(",");
  const todo = await env.DB.prepare(
    `SELECT s.id, s.turned_in_at, s.autograde_attempts, w.teacher_id FROM submissions s
     JOIN autograde_watch w ON w.coursework_id = s.coursework_id
     LEFT JOIN grades g ON g.submission_id = s.id
     WHERE s.coursework_id IN (${placeholders})
       AND s.state IN ('TURNED_IN', 'RETURNED')
       AND s.autograde_error IS NULL
       AND (s.turned_in_at IS NULL OR s.turned_in_at <= ?)
       AND (g.submission_id IS NULL
            OR (g.status = 'ai_suggested' AND COALESCE(g.locked, 0) = 0 AND s.turned_in_at > g.graded_at))
     ORDER BY COALESCE(s.turned_in_at, 0) LIMIT ?`
  )
    .bind(...synced, now - STABLE_S, gradesPerRun(env))
    .all<{ id: string; turned_in_at: number | null; autograde_attempts: number; teacher_id: string }>();

  // 3. 評分：同時 3 位；某位老師額度用完或授權失效，這輪就不再幫他評
  const stoppedTeachers = new Set<string>(expiredTeachers);
  const queue = [...todo.results];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      if (!s || stoppedTeachers.has(s.teacher_id)) continue;
      let out;
      try {
        out = await gradeOneSubmission(env, s.teacher_id, s.id);
      } catch (e) {
        // 換 token 失敗之類：不是這位學生的問題，這位老師這輪先停
        stoppedTeachers.add(s.teacher_id);
        summary.errors.push(`${s.id}: ${(e as Error).message}`.slice(0, 200));
        continue;
      }
      if (out.ok) {
        summary.graded++;
        continue;
      }
      if (out.category === "quota") {
        stoppedTeachers.add(s.teacher_id);
        summary.retryLater++;
      } else if (out.category === "permanent") {
        await markNeedsTeacher(env, s.id, out.error, s.turned_in_at);
        summary.needsTeacher++;
      } else if (out.category === "transient") {
        const attempts = (s.autograde_attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await markNeedsTeacher(env, s.id, `AI 連續 ${MAX_ATTEMPTS} 次沒評成功（${out.error}），請自己批改，或稍後按「請 AI 重評」`, s.turned_in_at);
          summary.needsTeacher++;
        } else {
          await env.DB.prepare("UPDATE submissions SET autograde_attempts = ? WHERE id = ?").bind(attempts, s.id).run();
          summary.retryLater++;
        }
      }
      // skip（正在評、剛被老師鎖定…）：什麼都不做，下一輪自然會重新判斷
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("[autograde]", JSON.stringify(summary));
  return summary;
}

// 每輪最多評幾位：wrangler.jsonc 的 AUTOGRADE_PER_RUN 可調（一次評太多可能碰到 Worker 單次執行的 CPU 上限）
function gradesPerRun(env: Env): number {
  const n = Number(env.AUTOGRADE_PER_RUN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GRADES_PER_RUN;
}

async function markNeedsTeacher(env: Env, submissionId: string, reason: string, turnedInAt: number | null) {
  await env.DB.prepare("UPDATE submissions SET autograde_error = ?, autograde_for_turned_in_at = ? WHERE id = ?")
    .bind(reason, turnedInAt, submissionId)
    .run();
}
