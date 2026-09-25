import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { getValidAccessToken } from "../lib/tokens";
import { syncCourseWorkSubmissions, watchCourseWork } from "../lib/sync";
import { gradeOneSubmission, logGradeHistory } from "../lib/grade";
import { isMeaningfulEdit, saveCalibrationExample } from "../lib/calibration";
import * as XLSX from "@e965/xlsx";
import { ownsCourse, ownsCourseWork } from "../lib/ownership";
import { courseWorkCanWriteBack, pushConfirmedGrades, teacherCanWrite } from "../lib/writeback";
import { buildInsights, getCachedInsights } from "../lib/insights";

export const submissionRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
submissionRoutes.use("*", requireAuth);

const SUBMISSIONS_SELECT = `
  SELECT s.*, g.ai_score, g.ai_feedback, g.final_score, g.final_feedback, g.status, g.ai_model, g.ai_raw_json, g.locked, g.confidence_flags, g.risk_level,
    g.updated_at AS grade_updated_at, p.pushed_score, p.pushed_at
  FROM submissions s LEFT JOIN grades g ON g.submission_id = s.id
  LEFT JOIN grade_pushes p ON p.submission_id = s.id
  WHERE s.coursework_id = ? ORDER BY s.student_name`;

// 只讀 D1 快取，不打 Classroom API——AI 評分完刷新畫面走這支，不要每評一個人就整班重拉一次
submissionRoutes.get("/:courseWorkId", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }

  const rows = await c.env.DB.prepare(SUBMISSIONS_SELECT).bind(courseWorkId).all();
  const watch = await c.env.DB.prepare("SELECT last_synced_at FROM autograde_watch WHERE coursework_id = ?")
    .bind(courseWorkId)
    .first<{ last_synced_at: number | null }>();
  // v1.18.0：這份作業能不能把分數送回 Classroom、老師有沒有給寫入權限，決定批改頁顯示哪種按鈕
  const [canWriteBack, canWrite] = await Promise.all([courseWorkCanWriteBack(c.env, courseWorkId), teacherCanWrite(c.env, teacherId)]);
  return c.json({ submissions: rows.results, autoSyncedAt: watch?.last_synced_at ?? null, canWriteBack, canWrite });
});

// v1.18.0 把老師確認過的分數送回 Classroom（草稿分數，老師在 Classroom 按「發還」才算數）
submissionRoutes.post("/:courseWorkId/push-grades", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  const out = await pushConfirmedGrades(c.env, teacherId, courseWorkId);
  if (!out.ok) return c.json({ error: out.error, code: out.code }, out.status);
  return c.json(out);
});

// v1.18.0 全班學習診斷：GET 只讀快取（不花 AI 次數），POST 才叫 AI 整理
submissionRoutes.get("/:courseWorkId/insights", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  return c.json(await getCachedInsights(c.env, courseWorkId));
});

submissionRoutes.post("/:courseWorkId/insights", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  const out = await buildInsights(c.env, teacherId, courseWorkId);
  if (!out.ok) return c.json({ error: out.error, code: out.code }, out.status);
  return c.json(out);
});

// 老師打開批改頁：這份作業交給背景自動預批 21 天（重複打開就延長），並清掉「要重新登入」的舊錯誤
submissionRoutes.post("/:courseWorkId/watch", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  await watchCourseWork(c.env, teacherId, courseWorkId);
  return c.json({ ok: true });
});

// 從 Classroom 拉某作業的所有已繳交內容，快取進 D1（不含 AI 評分）
// 這支較重（Classroom API + 全班名冊各一次請求），老師按「更新學生繳交」時呼叫；背景排程也用同一支 lib
submissionRoutes.post("/:courseId/:courseWorkId/sync", async (c) => {
  const teacherId = c.get("teacherId");
  const { courseId, courseWorkId } = c.req.param();
  if (!(await ownsCourse(c.env, teacherId, courseId))) {
    return c.json({ error: "找不到這門課，或不屬於你" }, 404);
  }
  const accessToken = await getValidAccessToken(c.env, teacherId);
  await syncCourseWorkSubmissions(c.env, accessToken, courseId, courseWorkId);

  const rows = await c.env.DB.prepare(SUBMISSIONS_SELECT).bind(courseWorkId).all();
  return c.json({ submissions: rows.results });
});

// 對單一份繳交跑 AI 評分；實際邏輯在 lib/grade.ts（背景自動預批共用）
submissionRoutes.post("/:submissionId/ai-grade", async (c) => {
  const out = await gradeOneSubmission(c.env, c.get("teacherId"), c.req.param("submissionId"), {
    force: c.req.query("force") === "1",
  });
  if (out.ok) {
    const { result, model, confidenceFlags, riskLevel, remainingToday } = out;
    return c.json({ grade: result, model, confidenceFlags, riskLevel, remainingToday });
  }
  const body: Record<string, unknown> = { error: out.error };
  if (out.code) body.code = out.code;
  if (out.kind) body.kind = out.kind;
  if (out.remainingToday !== undefined) body.remainingToday = out.remainingToday;
  return c.json(body, out.status as 400);
});

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
  finalScore: z.number().finite(),
  finalFeedback: z.string(),
  confirm: z.boolean().default(false),
});

const MAX_FEEDBACK_LENGTH = 5000;

// 老師改分數/評語，或 AI 沒評過（失敗、被擋）時老師自己打分；confirm=true 表示老師確認定案
submissionRoutes.patch("/:submissionId/grade", async (c) => {
  const teacherId = c.get("teacherId");
  const submissionId = c.req.param("submissionId");
  const body = updateGradeBody.parse(await c.req.json());
  const now = Math.floor(Date.now() / 1000);

  // 一次查完：是不是自己的學生、有沒有鎖定、這份作業總分幾分（評分標準的總分優先，跟前端顯示一致）
  const info = await c.env.DB.prepare(
    `SELECT r.id AS rubric_id, r.max_points AS rubric_max, cw.max_points AS cw_max, g.locked
     FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN course_teachers ct ON ct.course_id = cw.course_id
     LEFT JOIN rubrics r ON r.coursework_id = s.coursework_id
     LEFT JOIN grades g ON g.submission_id = s.id
     WHERE s.id = ? AND ct.teacher_id = ?`
  )
    .bind(submissionId, teacherId)
    .first<{ rubric_id: string | null; rubric_max: number | null; cw_max: number | null; locked: number | null }>();
  if (!info) return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);

  // 已鎖定（老師之前確認過）就不能直接改，要先解鎖——避免老師以為只是改個字，
  // 卻沒注意到這筆其實已經定案過，改完又忘了重新確認
  if (info.locked) {
    return c.json({ error: "這筆已經確認鎖定，請先按「解鎖」才能修改", code: "locked" }, 409);
  }

  const maxPoints = info.rubric_max ?? info.cw_max ?? 100;
  if (body.finalScore < 0 || body.finalScore > maxPoints) {
    return c.json({ error: `分數要在 0 到 ${maxPoints} 分之間` }, 400);
  }
  if (body.finalFeedback.length > MAX_FEEDBACK_LENGTH) {
    return c.json({ error: `評語太長了，請控制在 ${MAX_FEEDBACK_LENGTH} 字以內` }, 400);
  }

  // 沒有 grades 列（AI 從沒評成功過）就新增一列、ai_* 留空；有就只改老師的欄位，AI 的原始建議保留
  await c.env.DB.prepare(
    `INSERT INTO grades (id, submission_id, rubric_id, final_score, final_feedback, status, locked, graded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       final_score = excluded.final_score, final_feedback = excluded.final_feedback,
       status = excluded.status, locked = excluded.locked, updated_at = excluded.updated_at`
  )
    .bind(
      crypto.randomUUID(),
      submissionId,
      info.rubric_id,
      body.finalScore,
      body.finalFeedback,
      body.confirm ? "confirmed" : "teacher_edited",
      body.confirm ? 1 : 0,
      now,
      now
    )
    .run();

  // 老師自己打了分：「AI 評不了、要你自己批」的提醒就完成任務了（v1.17.0）
  await c.env.DB.prepare("UPDATE submissions SET autograde_error = NULL WHERE id = ?").bind(submissionId).run();

  await logGradeHistory(
    c.env.DB,
    submissionId,
    body.confirm ? "TEACHER_CONFIRM" : "TEACHER_EDIT",
    body.finalScore,
    body.finalFeedback,
    now
  );

  // 老師確認定案時，順手記一筆匿名校正資料（AI分數 vs 老師最終分數），供之後衡量
  // AI評分可信度。刻意不查、不存學生姓名或作業原文——只要分數差距，記錄失敗也不影響這次確認。
  if (body.confirm) {
    try {
      const calib = await c.env.DB.prepare(
        `SELECT g.ai_score, g.ai_feedback, g.rubric_id, r.mode, r.max_points, s.content_text FROM grades g
         JOIN submissions s ON s.id = g.submission_id
         JOIN rubrics r ON r.coursework_id = s.coursework_id
         WHERE g.submission_id = ?`
      )
        .bind(submissionId)
        .first<{
          ai_score: number | null;
          ai_feedback: string | null;
          rubric_id: string | null;
          mode: string;
          max_points: number;
          content_text: string | null;
        }>();
      if (calib && calib.ai_score != null) {
        await c.env.DB.prepare(
          `INSERT INTO grading_calibration_logs (id, mode, max_points, ai_score, teacher_final_score, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(crypto.randomUUID(), calib.mode, calib.max_points, calib.ai_score, body.finalScore, now)
          .run();

        // 只有老師真的改過分數（不是單純按確認）才值得存成這份評分標準的校準範例
        if (calib.rubric_id && calib.content_text && isMeaningfulEdit(calib.ai_score, body.finalScore, calib.max_points)) {
          await saveCalibrationExample(c.env.DB, {
            rubricId: calib.rubric_id,
            studentContent: calib.content_text,
            aiScore: calib.ai_score,
            aiFeedback: calib.ai_feedback,
            teacherFinalScore: body.finalScore,
            teacherFinalFeedback: body.finalFeedback,
            now,
          });
        }
      }
    } catch (e) {
      console.error("[grading_calibration_logs] 記錄失敗（不影響這次確認）", e);
    }
  }

  return c.json({ ok: true });
});

// 解鎖一筆已確認的評分，讓老師可以再編輯／請AI重評；不動分數評語本身，
// status 退回 teacher_edited（保留老師之前的內容，不是清空重來）
submissionRoutes.post("/:submissionId/unlock", async (c) => {
  const teacherId = c.get("teacherId");
  const submissionId = c.req.param("submissionId");
  const now = Math.floor(Date.now() / 1000);

  const current = await c.env.DB.prepare(
    `SELECT g.final_score, g.final_feedback FROM grades g
     JOIN submissions s ON s.id = g.submission_id
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN course_teachers ct ON ct.course_id = cw.course_id
     WHERE g.submission_id = ? AND ct.teacher_id = ?`
  )
    .bind(submissionId, teacherId)
    .first<{ final_score: number; final_feedback: string }>();
  if (!current) return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);

  await c.env.DB.prepare(
    `UPDATE grades SET locked = 0, status = 'teacher_edited', updated_at = ?
     WHERE submission_id = ? AND submission_id IN (
       SELECT s.id FROM submissions s
       JOIN coursework cw ON cw.id = s.coursework_id
       JOIN course_teachers ct ON ct.course_id = cw.course_id
       WHERE ct.teacher_id = ?
     )`
  )
    .bind(now, submissionId, teacherId)
    .run();

  await logGradeHistory(c.env.DB, submissionId, "TEACHER_REOPEN", current.final_score, current.final_feedback, now);

  return c.json({ ok: true });
});

// 這位學生的評分修改歷程（AI初評/AI重評/老師編輯/確認/解鎖），給老師回顧「為什麼分數變了」
submissionRoutes.get("/:submissionId/history", async (c) => {
  const teacherId = c.get("teacherId");
  const submissionId = c.req.param("submissionId");

  const owns = await c.env.DB.prepare(
    `SELECT 1 FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN course_teachers ct ON ct.course_id = cw.course_id
     WHERE s.id = ? AND ct.teacher_id = ?`
  )
    .bind(submissionId, teacherId)
    .first();
  if (!owns) return c.json({ error: "找不到這份繳交紀錄，或不屬於你" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT version_number, source, score, feedback, changed_at FROM grade_history
     WHERE submission_id = ? ORDER BY version_number DESC`
  )
    .bind(submissionId)
    .all();
  return c.json({ history: rows.results });
});
