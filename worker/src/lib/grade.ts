import type { Env, Rubric, AiGradeResult } from "../types";
import { getValidAccessToken } from "./tokens";
import { extractDriveFile, type ExtractedAttachment } from "./drive";
import { bytesToBase64 } from "./base64";
import { gradeSubmission, GradeError, type GradeFailKind } from "./gemini";
import { computeConfidenceFlags, injectionFlag, computeRiskLevel } from "./confidence";
import { checkAiQuota, recordAiUse } from "./usage";
import { fetchCalibrationExamples } from "./calibration";
import type { AttachmentRecord } from "./sync";

// 一次評分所有要下載的檔案（標準答案檔＋學生附件）原始大小合計上限。Gemini 一次可收 100MB，
// 但 Worker 只有 128MB 記憶體，原始位元組、base64、JSON 本體會同時存在，約吃掉 4 倍，20MB 是安全值
const MAX_TOTAL_INLINE_BYTES = 20 * 1024 * 1024;

// 同一位學生同時被「老師頁面」與「背景排程」評：後到的直接退，不重複花 AI 額度
const LOCK_TTL_S = 300;

/**
 * 失敗分類（背景排程靠這個決定下一步）：
 * - skip：這位現在不該評（找不到、鎖定、老師改過、還沒交、沒評分標準、正在評）
 * - permanent：AI 看不了這份（沒內容、附件讀不到、被安全機制擋、答案檔不見），學生重交前不要再試
 * - transient：這次運氣不好（AI 逾時、格式錯、額度暫滿），下一輪再試
 * - quota：這位老師今天／這分鐘的額度用完，這輪別再幫他評
 */
export type GradeFailCategory = "skip" | "permanent" | "transient" | "quota";

export type GradeOutcome =
  | {
      ok: true;
      result: AiGradeResult;
      model: string;
      confidenceFlags: string[];
      riskLevel: string;
      remainingToday: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
      category: GradeFailCategory;
      code?: string;
      kind?: GradeFailKind;
      remainingToday?: number;
    };

// 每筆評分異動都留一筆歷程（AI初評/AI重評/老師編輯/老師確認/老師解鎖），供老師回顧
// 「為什麼分數變了」；version_number 用目前已有幾筆歷程+1 算，不是另外維護計數器。
export async function logGradeHistory(
  db: D1Database,
  submissionId: string,
  source: "AI_INITIAL" | "AI_REGRADE" | "TEACHER_EDIT" | "TEACHER_CONFIRM" | "TEACHER_REOPEN",
  score: number | null,
  feedback: string | null,
  now: number,
  // 只有 AI_INITIAL/AI_REGRADE 會帶：這次 AI 當下怎麼判斷的快照，之後老師改分不會回頭改寫這兩欄
  aiReasoning: unknown = null,
  riskSignal: unknown = null
): Promise<void> {
  const countRow = await db
    .prepare("SELECT COUNT(*) AS n FROM grade_history WHERE submission_id = ?")
    .bind(submissionId)
    .first<{ n: number }>();
  await db
    .prepare(
      `INSERT INTO grade_history (id, submission_id, version_number, source, score, feedback, changed_at, ai_reasoning, risk_signal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      submissionId,
      (countRow?.n ?? 0) + 1,
      source,
      score,
      feedback,
      now,
      aiReasoning ? JSON.stringify(aiReasoning) : null,
      riskSignal ? JSON.stringify(riskSignal) : null
    )
    .run();
}

export const FRIENDLY_GRADE_ERRORS: Record<GradeFailKind, string> = {
  quota: "AI 使用量暫時滿了，請過幾分鐘再按「只重評失敗的」",
  timeout: "AI 這次回應太慢，請再按一次「只重評失敗的」",
  blocked: "這份作業的內容被 AI 的安全機制擋下，請自己批改這一位",
  bad_output: "AI 這次的回覆格式不對，請再評一次",
  unknown: "AI 評分沒有成功，請稍後再評一次；一直失敗就請自己批改這一位",
};

/** 對單一份繳交跑 AI 評分（讀 rubric、抓附件內容、呼叫 Gemini、存進 grades）。老師頁面與背景排程共用。 */
export async function gradeOneSubmission(
  env: Env,
  teacherId: string,
  submissionId: string,
  opts: { force?: boolean } = {}
): Promise<GradeOutcome> {
  // 權限檢查跟拿資料合成一次 D1 來回，這支是評分的熱路徑，批次評分一個班要打 N 次
  const submission = await env.DB.prepare(
    `SELECT s.* FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN course_teachers ct ON ct.course_id = cw.course_id
     WHERE s.id = ? AND ct.teacher_id = ?`
  )
    .bind(submissionId, teacherId)
    .first<any>();
  if (!submission) return { ok: false, status: 404, error: "找不到這份繳交紀錄，或不屬於你", category: "skip" };

  // 老師確認過的評分會自動鎖定，鎖定後「請AI重評」不能悄悄蓋掉——
  // 這是十輪功能討論的P0：老師人工確認的東西不能被AI重評覆蓋，要先按「解鎖」才能重評。
  const existingGrade = await env.DB.prepare("SELECT locked, status FROM grades WHERE submission_id = ?")
    .bind(submissionId)
    .first<{ locked: number; status: string }>();
  if (existingGrade?.locked) {
    return { ok: false, status: 409, error: "這筆已經確認鎖定，請先按「解鎖重新評分」才能請AI重評", code: "locked", category: "skip" };
  }
  // 老師改過分數或評語（含自己打分）：AI 重評會蓋掉老師的修改，要前端確認過（force）才做
  if (existingGrade?.status === "teacher_edited" && !opts.force) {
    return { ok: false, status: 409, error: "這位你已經改過分數或評語，AI 重評會蓋掉你的修改", code: "overwrite_teacher_edit", category: "skip" };
  }

  // rubrics 09-15 起已改真正 upsert（coursework_id 唯一），一份作業只會有 0 或 1 列
  const rubricRow = await env.DB.prepare("SELECT * FROM rubrics WHERE coursework_id = ?")
    .bind(submission.coursework_id)
    .first<any>();
  if (!rubricRow) return { ok: false, status: 400, error: "這份作業還沒設定評分標準", category: "skip" };

  const attachmentRecords: AttachmentRecord[] = submission.attachments_json ? JSON.parse(submission.attachments_json) : [];
  // 學生沒交、也沒有任何內容：不用浪費一次 AI 額度，直接告訴老師
  const turnedIn = submission.state === "TURNED_IN" || submission.state === "RETURNED";
  if (!turnedIn && !submission.content_text && attachmentRecords.length === 0) {
    return { ok: false, status: 400, error: "這位學生還沒交作業，等他交了再按「更新學生繳交」", category: "skip" };
  }

  const lockKey = `grading:${submissionId}`;
  if (await env.SESSIONS.get(lockKey)) {
    return { ok: false, status: 409, error: "這位學生正在評分中，請稍等一下再看", code: "grading_in_progress", category: "skip" };
  }
  await env.SESSIONS.put(lockKey, "1", { expirationTtl: LOCK_TTL_S });
  try {
    return await gradeLocked(env, teacherId, submissionId, submission, rubricRow, attachmentRecords, existingGrade);
  } finally {
    await env.SESSIONS.delete(lockKey);
  }
}

async function gradeLocked(
  env: Env,
  teacherId: string,
  submissionId: string,
  submission: any,
  rubricRow: any,
  attachmentRecords: AttachmentRecord[],
  existingGrade: { locked: number; status: string } | null
): Promise<GradeOutcome> {
  const rubric: Rubric = {
    id: rubricRow.id,
    courseworkId: rubricRow.coursework_id,
    mode: rubricRow.mode,
    instructions: rubricRow.instructions,
    rubricJson: rubricRow.rubric_json ? JSON.parse(rubricRow.rubric_json) : null,
    answerKey: rubricRow.answer_key,
    answerKeyFile:
      rubricRow.answer_key_file_r2_key || rubricRow.answer_key_file_base64 || rubricRow.answer_key_file_extracted_text
        ? {
            name: rubricRow.answer_key_file_name,
            mimeType: rubricRow.answer_key_file_mime,
            base64: rubricRow.answer_key_file_base64 ?? undefined,
            extractedText: rubricRow.answer_key_file_extracted_text ?? undefined,
          }
        : null,
    maxPoints: rubricRow.max_points,
  };

  const accessToken = await getValidAccessToken(env, teacherId);

  // 標準答案檔存在 R2（09-19 起），舊資料還在 D1 的 base64 欄位就照舊用
  let answerKeyBytes = 0;
  if (rubric.answerKeyFile && rubricRow.answer_key_file_r2_key) {
    const obj = await env.ATTACHMENTS.get(rubricRow.answer_key_file_r2_key);
    if (!obj) {
      console.error("[ai-grade] R2 找不到答案檔", rubricRow.answer_key_file_r2_key);
      return { ok: false, status: 500, error: "標準答案檔讀不到了，請到評分標準頁重新上傳一次", category: "permanent" };
    }
    const buf = await obj.arrayBuffer();
    answerKeyBytes = buf.byteLength;
    rubric.answerKeyFile.base64 = bytesToBase64(buf);
  } else if (rubric.answerKeyFile?.base64) {
    answerKeyBytes = (rubric.answerKeyFile.base64.length * 3) / 4;
  }

  // 只有真的讀到內容的附件才放進 extracted；太大、讀不到、AI 看不懂的格式（試算表、表單、連結、
  // 影片…）分開記，不然 AI 會在什麼都沒看到的情況下照樣給分
  const extracted: ExtractedAttachment[] = [];
  const tooLarge: string[] = [];
  const unreadable: string[] = [];
  let remainingBytes = MAX_TOTAL_INLINE_BYTES - answerKeyBytes;
  for (const att of attachmentRecords) {
    if (att.type === "doc" && att.driveFileId) {
      try {
        const got = await extractDriveFile(accessToken, att.driveFileId, att.name, remainingBytes);
        if (got.kind === "too_large") {
          tooLarge.push(got.name);
        } else if (got.kind === "unsupported" || (got.kind === "text" && !got.text?.trim())) {
          unreadable.push(got.name);
        } else {
          remainingBytes -= got.bytes ?? 0;
          extracted.push(got);
        }
      } catch (e) {
        unreadable.push(att.name);
        console.error("[ai-grade] 附件讀取失敗", att.name, e);
      }
    } else {
      unreadable.push(att.name);
    }
  }
  // AI 沒有任何作答內容可看：不叫 AI（給分只會亂猜），說清楚原因請老師自己看
  if (!submission.content_text?.trim() && extracted.length === 0) {
    const error =
      attachmentRecords.length === 0
        ? "學生按了繳交但沒有寫任何內容、也沒有附檔案，AI 沒東西可以評，請自己確認"
        : tooLarge.length > 0 && unreadable.length === 0
          ? "學生交的檔案太大（單檔超過 15MB，或全部加起來超過 20MB），AI 讀不了，請打開原檔自己看"
          : "學生交的檔案 AI 讀不到（可能是連結、試算表、表單、影片，或雲端硬碟權限不足），請打開原檔自己看";
    return { ok: false, status: 422, error, category: "permanent" };
  }

  // 用量上限：擋住一位老師把大家共用的 AI 額度吃光。放在這裡＝前面那些「根本不用打 AI」的情況不扣次數
  const quota = await checkAiQuota(env, teacherId);
  if (!quota.ok) {
    const error =
      quota.reason === "daily"
        ? `今天的 AI 評分次數用完了（每人每天 ${quota.dailyLimit} 次），明天會重置。你還是可以按「自己打分」繼續批改`
        : "AI 評分太密集了，請等一分鐘再試（這是為了不要把大家共用的 AI 額度一次用光）";
    return {
      ok: false,
      status: 429,
      error,
      code: quota.reason === "daily" ? "quota_daily" : "quota_minute",
      remainingToday: quota.remainingToday,
      category: "quota",
    };
  }

  try {
    const examples = await fetchCalibrationExamples(env.DB, rubric.id);
    const apiKeys = env.GEMINI_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
    const { result, model } = await gradeSubmission(apiKeys, rubric, submission.content_text ?? "", extracted, examples);
    // 真的打了 Gemini 且成功才計次：AI 自己失敗（額度、逾時）不扣老師的次數
    const remainingToday = await recordAiUse(env, teacherId);
    const now = Math.floor(Date.now() / 1000);
    const confidenceFlags = computeConfidenceFlags(rubric, result);
    // 學生試圖對 AI 下指令（要求給滿分之類）：AI 自己的判斷＋後端句型比對，任一成立就警示
    const injection = injectionFlag(result, [
      submission.content_text ?? "",
      ...extracted.map((a) => (a.kind === "text" ? a.text ?? "" : "")),
    ]);
    if (injection) confidenceFlags.unshift(injection);
    // 有附件因為太大沒送給 AI：分數只根據其他內容，老師一定要知道
    if (tooLarge.length > 0) {
      confidenceFlags.push(`有 ${tooLarge.length} 個附件太大 AI 沒讀到（${tooLarge.join("、")}），這個分數沒有看過這些檔案`);
    }
    if (unreadable.length > 0) {
      confidenceFlags.push(`有 ${unreadable.length} 個附件 AI 讀不到（${unreadable.join("、")}），這個分數沒有看過這些檔案`);
    }
    const confidenceFlagsJson = confidenceFlags.length > 0 ? JSON.stringify(confidenceFlags) : null;
    // 三色分流：見 lib/confidence.ts computeRiskLevel 的說明（不另外多打AI，用已經有的證據組合）
    const riskLevel = computeRiskLevel(confidenceFlags, result.score, rubric.maxPoints, examples.length > 0);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO grades (id, submission_id, rubric_id, ai_score, ai_feedback, ai_raw_json, ai_model, confidence_flags, risk_level, final_score, final_feedback, status, graded_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_suggested', ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET
           rubric_id = excluded.rubric_id, ai_score = excluded.ai_score, ai_feedback = excluded.ai_feedback,
           ai_raw_json = excluded.ai_raw_json, ai_model = excluded.ai_model, confidence_flags = excluded.confidence_flags,
           risk_level = excluded.risk_level,
           final_score = excluded.ai_score, final_feedback = excluded.ai_feedback,
           status = 'ai_suggested', graded_at = excluded.graded_at, updated_at = excluded.updated_at`
      ).bind(
        crypto.randomUUID(),
        submissionId,
        rubric.id,
        result.score,
        result.feedback,
        JSON.stringify(result),
        model,
        confidenceFlagsJson,
        riskLevel,
        result.score,
        result.feedback,
        now,
        now
      ),
      // 評成功就清掉之前「AI 評不了」的紀錄（例如老師手動按了重評）
      env.DB.prepare("UPDATE submissions SET autograde_error = NULL, autograde_attempts = 0 WHERE id = ?").bind(submissionId),
    ]);

    await logGradeHistory(
      env.DB,
      submissionId,
      existingGrade ? "AI_REGRADE" : "AI_INITIAL",
      result.score,
      result.feedback,
      now,
      { itemScores: result.itemScores ?? null, feedback: result.feedback },
      { level: riskLevel, flags: confidenceFlags }
    );

    return { ok: true, result, model, confidenceFlags, riskLevel, remainingToday };
  } catch (e) {
    console.error("[ai-grade]", e);
    const kind: GradeFailKind = e instanceof GradeError ? e.kind : "unknown";
    return {
      ok: false,
      status: kind === "quota" ? 429 : 502,
      error: FRIENDLY_GRADE_ERRORS[kind],
      kind,
      category: kind === "blocked" ? "permanent" : "transient",
    };
  }
}
