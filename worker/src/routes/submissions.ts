import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables, Rubric } from "../types";
import { requireAuth } from "../middleware";
import { getValidAccessToken } from "../lib/tokens";
import { listStudentSubmissions, listStudentsMap } from "../lib/classroom";
import { extractDriveFile, type ExtractedAttachment } from "../lib/drive";
import { gradeSubmission } from "../lib/gemini";
import { ownsCourse, ownsCourseWork, ownsSubmission } from "../lib/ownership";

export const submissionRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
submissionRoutes.use("*", requireAuth);

interface AttachmentRecord {
  type: "doc" | "image" | "pdf" | "link" | "unsupported";
  driveFileId?: string;
  name: string;
  mimeType?: string;
  url?: string;
}

const SUBMISSIONS_SELECT = `
  SELECT s.*, g.ai_score, g.ai_feedback, g.final_score, g.final_feedback, g.status, g.ai_model
  FROM submissions s LEFT JOIN grades g ON g.submission_id = s.id
  WHERE s.coursework_id = ? ORDER BY s.student_name`;

// 只讀 D1 快取，不打 Classroom API——AI 評分完刷新畫面走這支，不要每評一個人就整班重拉一次
submissionRoutes.get("/:courseWorkId", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }

  const rows = await c.env.DB.prepare(SUBMISSIONS_SELECT).bind(courseWorkId).all();
  return c.json({ submissions: rows.results });
});

// 從 Classroom 拉某作業的所有已繳交內容，快取進 D1（不含 AI 評分，評分要老師另外按）
// 這支較重（Classroom API + 全班名冊各一次請求），只在老師按「拉取最新繳交」時呼叫
submissionRoutes.post("/:courseId/:courseWorkId/sync", async (c) => {
  const teacherId = c.get("teacherId");
  const { courseId, courseWorkId } = c.req.param();
  if (!(await ownsCourse(c.env, teacherId, courseId))) {
    return c.json({ error: "找不到這門課，或不屬於你" }, 404);
  }
  const accessToken = await getValidAccessToken(c.env, teacherId);

  // 全班名冊一次抓完，不要逐個學生打一次 API（30 人的班級從 30 次請求降到 1～2 次）
  const [submissions, nameMap] = await Promise.all([
    listStudentSubmissions(accessToken, courseId, courseWorkId),
    listStudentsMap(accessToken, courseId),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const statements = submissions.map((sub) => {
    const studentName = nameMap.get(sub.userId) ?? sub.userId;
    const contentText = sub.shortAnswerSubmission?.answer ?? "";
    const attachments: AttachmentRecord[] = (sub.assignmentSubmission?.attachments ?? []).map((att) => {
      if (att.driveFile) {
        return { type: "doc", driveFileId: att.driveFile.id, name: att.driveFile.title };
      }
      if (att.link) {
        return { type: "link", name: att.link.title ?? att.link.url, url: att.link.url };
      }
      return { type: "unsupported", name: "未知附件" };
    });

    return c.env.DB.prepare(
      `INSERT INTO submissions (id, coursework_id, student_id, student_name, state, content_text, attachments_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, content_text = excluded.content_text,
         attachments_json = excluded.attachments_json, fetched_at = excluded.fetched_at`
    ).bind(sub.id, courseWorkId, sub.userId, studentName, sub.state, contentText, JSON.stringify(attachments), now);
  });

  // D1 batch：一次送出整批寫入，不要在迴圈裡逐筆 await（30 個學生就是 30 次來回）
  if (statements.length) await c.env.DB.batch(statements);

  const rows = await c.env.DB.prepare(SUBMISSIONS_SELECT).bind(courseWorkId).all();
  return c.json({ submissions: rows.results });
});

// 對單一份繳交跑 AI 評分（讀 rubric、抓附件內容、呼叫 Gemini、存進 grades）
submissionRoutes.post("/:submissionId/ai-grade", async (c) => {
  const teacherId = c.get("teacherId");
  const submissionId = c.req.param("submissionId");
  if (!(await ownsSubmission(c.env, teacherId, submissionId))) {
    return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);
  }

  const submission = await c.env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(submissionId).first<any>();
  if (!submission) return c.json({ error: "找不到這份繳交紀錄，請先拉取作業" }, 404);

  const rubricRow = await c.env.DB.prepare(
    "SELECT * FROM rubrics WHERE coursework_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(submission.coursework_id)
    .first<any>();
  if (!rubricRow) return c.json({ error: "這份作業還沒設定評分標準" }, 400);

  const rubric: Rubric = {
    id: rubricRow.id,
    courseworkId: rubricRow.coursework_id,
    mode: rubricRow.mode,
    instructions: rubricRow.instructions,
    rubricJson: rubricRow.rubric_json ? JSON.parse(rubricRow.rubric_json) : null,
    answerKey: rubricRow.answer_key,
    maxPoints: rubricRow.max_points,
  };

  const accessToken = await getValidAccessToken(c.env, teacherId);
  const attachmentRecords: AttachmentRecord[] = submission.attachments_json ? JSON.parse(submission.attachments_json) : [];

  const extracted: ExtractedAttachment[] = [];
  for (const att of attachmentRecords) {
    if (att.type === "doc" && att.driveFileId) {
      try {
        extracted.push(await extractDriveFile(accessToken, att.driveFileId, att.name));
      } catch (e) {
        console.error("[ai-grade] 附件讀取失敗", att.name, e);
      }
    }
  }

  try {
    const { result, model } = await gradeSubmission(c.env.GEMINI_API_KEY, rubric, submission.content_text ?? "", extracted);
    const now = Math.floor(Date.now() / 1000);
    const gradeId = crypto.randomUUID();

    await c.env.DB.prepare(
      `INSERT INTO grades (id, submission_id, rubric_id, ai_score, ai_feedback, ai_raw_json, ai_model, final_score, final_feedback, status, graded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_suggested', ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         rubric_id = excluded.rubric_id, ai_score = excluded.ai_score, ai_feedback = excluded.ai_feedback,
         ai_raw_json = excluded.ai_raw_json, ai_model = excluded.ai_model,
         final_score = excluded.ai_score, final_feedback = excluded.ai_feedback,
         status = 'ai_suggested', graded_at = excluded.graded_at, updated_at = excluded.updated_at`
    )
      .bind(
        gradeId,
        submissionId,
        rubric.id,
        result.score,
        result.feedback,
        JSON.stringify(result),
        model,
        result.score,
        result.feedback,
        now,
        now
      )
      .run();

    return c.json({ grade: result, model });
  } catch (e) {
    console.error("[ai-grade]", e);
    return c.json({ error: `AI 評分失敗：${(e as Error).message}` }, 502);
  }
});

const updateGradeBody = z.object({
  finalScore: z.number(),
  finalFeedback: z.string(),
  confirm: z.boolean().default(false),
});

// 老師微調分數/評語；confirm=true 表示老師確認定案
submissionRoutes.patch("/:submissionId/grade", async (c) => {
  const teacherId = c.get("teacherId");
  const submissionId = c.req.param("submissionId");
  if (!(await ownsSubmission(c.env, teacherId, submissionId))) {
    return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);
  }
  const body = updateGradeBody.parse(await c.req.json());
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `UPDATE grades SET final_score = ?, final_feedback = ?, status = ?, updated_at = ? WHERE submission_id = ?`
  )
    .bind(body.finalScore, body.finalFeedback, body.confirm ? "confirmed" : "teacher_edited", now, submissionId)
    .run();

  return c.json({ ok: true });
});
