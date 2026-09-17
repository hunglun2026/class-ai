import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables, Rubric } from "../types";
import { requireAuth } from "../middleware";
import { getValidAccessToken } from "../lib/tokens";
import { listStudentSubmissions, listStudentsMap } from "../lib/classroom";
import { extractDriveFile, type ExtractedAttachment } from "../lib/drive";
import { gradeSubmission, GradeError, type GradeFailKind } from "../lib/gemini";
import * as XLSX from "@e965/xlsx";
import { ownsCourse, ownsCourseWork } from "../lib/ownership";

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
  SELECT s.*, g.ai_score, g.ai_feedback, g.final_score, g.final_feedback, g.status, g.ai_model, g.ai_raw_json
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

  // 權限檢查跟拿資料合成一次 D1 來回（原本是兩次：先查歸屬、查到才再查一次同一筆），
  // 這支是評分的熱路徑，批次評分一個班要打 N 次
  const submission = await c.env.DB.prepare(
    `SELECT s.* FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN courses c ON c.id = cw.course_id
     WHERE s.id = ? AND c.teacher_id = ?`
  )
    .bind(submissionId, teacherId)
    .first<any>();
  if (!submission) return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);

  // rubrics 09-15 起已改真正 upsert（coursework_id 唯一），一份作業只會有 0 或 1 列，不用再排序取最新
  const rubricRow = await c.env.DB.prepare("SELECT * FROM rubrics WHERE coursework_id = ?")
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
    answerKeyFile:
      rubricRow.answer_key_file_base64 || rubricRow.answer_key_file_extracted_text
        ? {
            name: rubricRow.answer_key_file_name,
            mimeType: rubricRow.answer_key_file_mime,
            base64: rubricRow.answer_key_file_base64 ?? undefined,
            extractedText: rubricRow.answer_key_file_extracted_text ?? undefined,
          }
        : null,
    maxPoints: rubricRow.max_points,
  };

  const accessToken = await getValidAccessToken(c.env, teacherId);
  const attachmentRecords: AttachmentRecord[] = submission.attachments_json ? JSON.parse(submission.attachments_json) : [];

  // 學生沒交、也沒有任何內容：不用浪費一次 AI 額度，直接告訴老師
  const turnedIn = submission.state === "TURNED_IN" || submission.state === "RETURNED";
  if (!turnedIn && !submission.content_text && attachmentRecords.length === 0) {
    return c.json({ error: "這位學生還沒交作業，等他交了再按「更新學生繳交」" }, 400);
  }

  const extracted: ExtractedAttachment[] = [];
  let unreadable = 0;
  for (const att of attachmentRecords) {
    if (att.type === "doc" && att.driveFileId) {
      try {
        extracted.push(await extractDriveFile(accessToken, att.driveFileId, att.name));
      } catch (e) {
        unreadable += 1;
        console.error("[ai-grade] 附件讀取失敗", att.name, e);
      }
    }
  }
  // 學生只交了附件、而且全部讀不到：AI 沒東西可看，給分只會亂猜
  if (!submission.content_text && extracted.length === 0 && unreadable > 0) {
    return c.json({ error: "學生交的檔案讀不到（可能是雲端硬碟權限或檔案格式），請打開原檔自己看" }, 422);
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
    const kind: GradeFailKind = e instanceof GradeError ? e.kind : "unknown";
    return c.json({ error: FRIENDLY_GRADE_ERRORS[kind], kind }, kind === "quota" ? 429 : 502);
  }
});

const FRIENDLY_GRADE_ERRORS: Record<GradeFailKind, string> = {
  quota: "AI 使用量暫時滿了，請過幾分鐘再按「只重評失敗的」",
  timeout: "AI 這次回應太慢，請再按一次「只重評失敗的」",
  blocked: "這份作業的內容被 AI 的安全機制擋下，請自己批改這一位",
  bad_output: "AI 這次的回覆格式不對，請再評一次",
  unknown: "AI 評分沒有成功，請稍後再評一次；一直失敗就請自己批改這一位",
};

const STATUS_LABELS: Record<string, string> = {
  ai_suggested: "AI 建議（未確認）",
  teacher_edited: "老師改過（未完成）",
  confirmed: "已完成批改",
};

// 匯出全班成績表（.xlsx；CSV 在 Excel 開中文會亂碼）
submissionRoutes.get("/:courseWorkId/export.xlsx", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  const rows = await c.env.DB.prepare(SUBMISSIONS_SELECT).bind(courseWorkId).all<any>();
  const cw = await c.env.DB.prepare("SELECT title FROM coursework WHERE id = ?").bind(courseWorkId).first<{ title: string }>();

  const data = rows.results.map((r) => ({
    姓名: r.student_name,
    分數: r.final_score ?? r.ai_score ?? "",
    評語: r.final_feedback ?? r.ai_feedback ?? "",
    狀態: STATUS_LABELS[r.status ?? ""] ?? "尚未評分",
  }));
  const sheet = XLSX.utils.json_to_sheet(data, { header: ["姓名", "分數", "評語", "狀態"] });
  sheet["!cols"] = [{ wch: 12 }, { wch: 6 }, { wch: 80 }, { wch: 16 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "成績");
  const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

  // 檔名只留安全字元，避免作業標題裡的引號或換行弄壞標頭
  const safeTitle = (cw?.title ?? "作業").replace(/[\\/:*?"<>|\r\n]/g, "").slice(0, 60) || "作業";
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="grades.xlsx"; filename*=UTF-8''${encodeURIComponent(safeTitle + "_成績.xlsx")}`,
    },
  });
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
  const body = updateGradeBody.parse(await c.req.json());
  const now = Math.floor(Date.now() / 1000);

  // 權限檢查併進 UPDATE 的 WHERE，不要跟前面 ai-grade 一樣先查一次歸屬再寫一次——
  // 這支是老師改分/確認的路徑，每次編輯評語都會打，改完看 changes 判斷有沒有真的動到
  const result = await c.env.DB.prepare(
    `UPDATE grades SET final_score = ?, final_feedback = ?, status = ?, updated_at = ?
     WHERE submission_id = ? AND submission_id IN (
       SELECT s.id FROM submissions s
       JOIN coursework cw ON cw.id = s.coursework_id
       JOIN courses c ON c.id = cw.course_id
       WHERE c.teacher_id = ?
     )`
  )
    .bind(body.finalScore, body.finalFeedback, body.confirm ? "confirmed" : "teacher_edited", now, submissionId, teacherId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);
  }
  return c.json({ ok: true });
});
