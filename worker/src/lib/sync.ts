import type { Env } from "../types";
import { listStudentSubmissions, listStudentsMap, lastTurnedInAt } from "./classroom";

export interface AttachmentRecord {
  type: "doc" | "image" | "pdf" | "link" | "unsupported";
  driveFileId?: string;
  name: string;
  mimeType?: string;
  url?: string;
}

/**
 * 從 Classroom 拉某作業的所有已繳交內容，快取進 D1（不含 AI 評分）。
 * 老師按「更新學生繳交」與背景自動預批（lib/autograde.ts）共用這支。
 * 學生重交（turned_in_at 變了）時清掉上一版的 autograde_error／attempts，讓 AI 重新試。
 */
export async function syncCourseWorkSubmissions(
  env: Env,
  accessToken: string,
  courseId: string,
  courseWorkId: string
): Promise<number> {
  // 全班名冊一次抓完，不要逐個學生打一次 API（30 人的班級從 30 次請求降到 1～2 次）
  const [submissions, nameMap] = await Promise.all([
    listStudentSubmissions(accessToken, courseId, courseWorkId),
    listStudentsMap(accessToken, courseId),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const statements = submissions.map((sub) => {
    const studentName = nameMap.get(sub.userId) ?? sub.userId;
    // 簡答題與選擇題的作答都在 Classroom 本身，不是附件（選擇題以前沒讀，全班會被當成空白繳交）
    const contentText = sub.shortAnswerSubmission?.answer ?? sub.multipleChoiceSubmission?.answer ?? "";
    const attachments: AttachmentRecord[] = (sub.assignmentSubmission?.attachments ?? []).map((att) => {
      if (att.driveFile) {
        // alternateLink：老師在工具裡點得開學生原檔（Classroom 本來就會回，存起來不用再打 API）
        return { type: "doc", driveFileId: att.driveFile.id, name: att.driveFile.title, url: att.driveFile.alternateLink };
      }
      if (att.link) {
        return { type: "link", name: att.link.title ?? att.link.url, url: att.link.url };
      }
      return { type: "unsupported", name: "未知附件" };
    });

    return env.DB.prepare(
      `INSERT INTO submissions (id, coursework_id, student_id, student_name, state, content_text, attachments_json, fetched_at, turned_in_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, content_text = excluded.content_text,
         attachments_json = excluded.attachments_json, fetched_at = excluded.fetched_at, turned_in_at = excluded.turned_in_at,
         autograde_error = CASE WHEN excluded.turned_in_at IS NOT submissions.turned_in_at THEN NULL ELSE submissions.autograde_error END,
         autograde_attempts = CASE WHEN excluded.turned_in_at IS NOT submissions.turned_in_at THEN 0 ELSE submissions.autograde_attempts END`
    ).bind(sub.id, courseWorkId, sub.userId, studentName, sub.state, contentText, JSON.stringify(attachments), now, lastTurnedInAt(sub));
  });

  // D1 batch：一次送出整批寫入，不要在迴圈裡逐筆 await（30 個學生就是 30 次來回）
  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

const WATCH_DAYS = 21;

/** 老師存評分標準或打開批改頁時呼叫：這份作業交給背景自動預批 21 天（重複呼叫就延長）。 */
export async function watchCourseWork(env: Env, teacherId: string, courseWorkId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO autograde_watch (coursework_id, course_id, teacher_id, watch_until, last_error)
     SELECT cw.id, cw.course_id, ?, ?, NULL FROM coursework cw WHERE cw.id = ?
     ON CONFLICT(coursework_id) DO UPDATE SET teacher_id = excluded.teacher_id,
       watch_until = excluded.watch_until, last_error = NULL`
  )
    .bind(teacherId, now + WATCH_DAYS * 86400, courseWorkId)
    .run();
}
