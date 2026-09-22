import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { ownsCourseWork } from "../lib/ownership";
import { extractExcelText } from "../lib/excel";
import { extractDocxText } from "../lib/docx";
import { base64ToBytes } from "../lib/base64";
import { getClassroomRubric, classroomRubricToItems } from "../lib/classroom";
import { getValidAccessToken } from "../lib/tokens";

export const rubricRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
rubricRoutes.use("*", requireAuth);

// 長度上限：擋誤貼整本書，也防有人繞過前端灌大量資料
const rubricItemSchema = z.object({
  item: z.string().trim().min(1).max(100),
  maxPoints: z.number().finite().min(0),
  description: z.string().max(1000).optional(),
});

// 8MB 原始檔案上限（base64 字串長度約是原始位元組的 4/3 倍）。圖片/PDF 存 R2 不受 D1 單列 2MB 限制，
// 這個上限是為了評分時整包載入 Worker 記憶體（128MB）還有餘裕，跟學生附件共用 submissions.ts 的總量預算
export const MAX_ANSWER_KEY_FILE_BYTES = 8 * 1024 * 1024;
const EXCEL_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// txt／md／csv 前端都標成 text/plain，後端只需要認這一種
const TEXT_MIME = "text/plain";
// 抽出來的文字存在 D1 一列裡（單列上限 2MB），中文一字約 3 位元組，超過就砍，避免寫入失敗
const MAX_EXTRACTED_CHARS = 200000;
const ALLOWED_ANSWER_KEY_FILE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  ...EXCEL_MIME_TYPES,
  DOCX_MIME,
  TEXT_MIME,
];

const answerKeyFileSchema = z.object({
  name: z.string(),
  mimeType: z.enum(ALLOWED_ANSWER_KEY_FILE_MIME as [string, ...string[]]),
  base64: z.string(),
});

const upsertSchema = z.object({
  courseWorkId: z.string(),
  mode: z.enum(["freetext", "rubric", "answer_key"]),
  instructions: z.string().max(5000).optional(),
  rubricItems: z.array(rubricItemSchema).max(30).optional(),
  answerKey: z.string().max(20000).optional(),
  // 都沒帶＝這次沒換答案檔，維持資料庫裡原本存的（不管是有檔案還是沒檔案）
  answerKeyFile: answerKeyFileSchema.optional(),
  removeAnswerKeyFile: z.boolean().optional(),
  maxPoints: z.number().finite().positive().max(1000).default(100),
});

// 一份作業只有一套評分規則，upsert（第一次存是INSERT，之後都是原地UPDATE，不會一直長出新版本）
rubricRoutes.get("/:courseWorkId", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  // 故意不選 answer_key_file_base64/answer_key_file_extracted_text：只是要顯示「已上傳 xxx.pdf」，
  // 沒必要把整包檔案內容送回前端
  const row = await c.env.DB.prepare(
    `SELECT id, coursework_id, mode, instructions, rubric_json, answer_key, answer_key_file_name, answer_key_file_mime, max_points, created_at, updated_at
     FROM rubrics WHERE coursework_id = ?`
  )
    .bind(courseWorkId)
    .first();
  // 給前端防呆用：這份作業在 Classroom 的滿分、已經評過幾位、目前最高分（改總分時要警告）
  const stats = await c.env.DB.prepare(
    `SELECT cw.max_points AS cw_max,
       (SELECT COUNT(*) FROM grades g JOIN submissions s ON s.id = g.submission_id WHERE s.coursework_id = cw.id) AS graded,
       (SELECT MAX(g.final_score) FROM grades g JOIN submissions s ON s.id = g.submission_id WHERE s.coursework_id = cw.id) AS max_given
     FROM coursework cw WHERE cw.id = ?`
  )
    .bind(courseWorkId)
    .first<{ cw_max: number | null; graded: number; max_given: number | null }>();
  const extra = {
    courseworkMaxPoints: stats?.cw_max ?? null,
    gradedCount: stats?.graded ?? 0,
    maxGivenScore: stats?.max_given ?? null,
  };
  if (!row) return c.json({ rubric: null, ...extra });
  return c.json({
    ...extra,
    rubric: {
      ...row,
      rubricJson: row.rubric_json ? JSON.parse(row.rubric_json as string) : null,
      // base64 不回傳給前端（只是顯示「已上傳 xxx.pdf」用不到內容，省下每次讀頁面的流量）
      answerKeyFile: row.answer_key_file_name
        ? { name: row.answer_key_file_name, mimeType: row.answer_key_file_mime }
        : null,
    },
  });
});

// 讀老師在 Classroom 網頁已經設定好的量表（不存進 D1，純預覽；老師確認後才會呼叫下面的 POST 存檔）。
// 找不到／讀不到都回 { rubric: null }，前端據此顯示「沒有找到 Classroom 量表」而不是報錯。
rubricRoutes.get("/:courseWorkId/classroom", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  const cw = await c.env.DB.prepare("SELECT course_id, max_points FROM coursework WHERE id = ?")
    .bind(courseWorkId)
    .first<{ course_id: string; max_points: number | null }>();
  if (!cw) return c.json({ rubric: null });

  const accessToken = await getValidAccessToken(c.env, teacherId);
  const classroomRubric = await getClassroomRubric(accessToken, cw.course_id, courseWorkId);
  if (!classroomRubric) return c.json({ rubric: null });

  const rubricItems = classroomRubricToItems(classroomRubric);
  const maxPoints = rubricItems.reduce((sum, it) => sum + it.maxPoints, 0);
  return c.json({ rubric: { rubricItems, maxPoints } });
});

rubricRoutes.post("/", async (c) => {
  const teacherId = c.get("teacherId");
  const body = upsertSchema.parse(await c.req.json());
  if (!(await ownsCourseWork(c.env, teacherId, body.courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  // 量表模式：至少一項、項目不重複、各項加總等於總分（前端也會擋，這裡防有人繞過）
  if (body.mode === "rubric") {
    const items = body.rubricItems ?? [];
    if (items.length === 0) return c.json({ error: "量表至少要有一個評分項目" }, 400);
    const names = items.map((it) => it.item.trim());
    if (new Set(names).size !== names.length) return c.json({ error: "評分項目的名稱不能重複" }, 400);
    const sum = items.reduce((a, it) => a + it.maxPoints, 0);
    if (Math.abs(sum - body.maxPoints) > 1e-6) {
      return c.json({ error: `各項配分加起來是 ${sum} 分，要等於總分 ${body.maxPoints} 分` }, 400);
    }
  }

  // 三種情況：換新檔案／明確移除／兩者都沒帶（這次沒動檔案，UPDATE時完全不碰檔案欄位，維持原樣）
  let fileName: string | null = null;
  let fileMime: string | null = null;
  let fileExtractedText: string | null = null;
  let fileR2Key: string | null = null;
  const touchFileColumns = !!body.answerKeyFile || !!body.removeAnswerKeyFile;

  // 換檔／移除時要先記下舊的 R2 物件，DB 寫成功後再刪，不然會留下沒人用的孤兒檔
  const oldR2Key = touchFileColumns
    ? (
        await c.env.DB.prepare("SELECT answer_key_file_r2_key FROM rubrics WHERE coursework_id = ?")
          .bind(body.courseWorkId)
          .first<{ answer_key_file_r2_key: string | null }>()
      )?.answer_key_file_r2_key ?? null
    : null;

  if (body.answerKeyFile) {
    // base64 字串長度 * 3/4 還原成原始位元組數，粗估即可，用來擋過大檔案
    if ((body.answerKeyFile.base64.length * 3) / 4 > MAX_ANSWER_KEY_FILE_BYTES) {
      return c.json({ error: "檔案太大，標準答案檔請控制在 8MB 以內" }, 413);
    }
    fileName = body.answerKeyFile.name;
    fileMime = body.answerKeyFile.mimeType;

    if (EXCEL_MIME_TYPES.includes(fileMime)) {
      // Excel 不是圖片/PDF，AI 讀不懂二進位格式，先在這裡解析成文字表格存起來，
      // 原始檔案就不用留（評分時只會用到解析後的文字）
      try {
        fileExtractedText = extractExcelText(body.answerKeyFile.base64);
      } catch (e) {
        console.error("[rubrics] Excel 解析失敗", e);
        return c.json({ error: "這個 Excel 檔讀不出來，可能檔案損壞或有密碼保護。請用 Excel 打開後另存成新的 .xlsx 再上傳" }, 400);
      }
    } else if (fileMime === DOCX_MIME || fileMime === TEXT_MIME) {
      // Word／純文字跟 Excel 一樣：上傳時就解析成文字存起來，評分時直接給 AI 讀
      try {
        const bytes = base64ToBytes(body.answerKeyFile.base64);
        const text =
          fileMime === DOCX_MIME
            ? extractDocxText(bytes)
            : new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
        fileExtractedText = text.trim().slice(0, MAX_EXTRACTED_CHARS);
      } catch (e) {
        console.error("[rubrics] 文字檔解析失敗", e);
        return c.json({ error: "這個檔案讀不出來，可能檔案損壞或有密碼保護。請重新另存成新的檔案再上傳" }, 400);
      }
      if (!fileExtractedText) {
        return c.json({ error: "這個檔案裡沒有讀到文字（可能整份都是圖片），請改傳 PDF 或照片，或把答案貼到文字框" }, 400);
      }
    } else {
      // 圖片/PDF 放 R2：D1 單列上限 2MB，base64 後原始檔超過約 1.4MB 就存不進 D1
      fileR2Key = `answer-keys/${body.courseWorkId}/${crypto.randomUUID()}`;
      await c.env.ATTACHMENTS.put(fileR2Key, base64ToBytes(body.answerKeyFile.base64), {
        httpMetadata: { contentType: fileMime },
      });
    }
  }
  // body.removeAnswerKeyFile 時 fileName/fileMime/fileR2Key/fileExtractedText 保持 null，
  // 剛好就是「清空檔案」要寫回去的值

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  // 檔案欄位只有真的要換/移除時才出現在 SET 子句裡，這次沒動檔案就完全不觸碰那幾欄。
  // answer_key_file_base64 是 R2 之前的舊存法，換檔／移除時一併清成 NULL
  const fileSetClause = touchFileColumns
    ? ", answer_key_file_name = excluded.answer_key_file_name, answer_key_file_mime = excluded.answer_key_file_mime, answer_key_file_base64 = NULL, answer_key_file_extracted_text = excluded.answer_key_file_extracted_text, answer_key_file_r2_key = excluded.answer_key_file_r2_key"
    : "";

  // ON CONFLICT時原本的id不會被覆蓋，用RETURNING拿真正存在DB裡的那個id（不是id這個變數，
  // 那個只在真的新建立時才會派上用場）
  let saved: { id: string } | null;
  try {
    saved = await c.env.DB.prepare(
      `INSERT INTO rubrics (id, coursework_id, mode, instructions, rubric_json, answer_key, answer_key_file_name, answer_key_file_mime, answer_key_file_extracted_text, answer_key_file_r2_key, max_points, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(coursework_id) DO UPDATE SET
         mode = excluded.mode, instructions = excluded.instructions, rubric_json = excluded.rubric_json,
         answer_key = excluded.answer_key, max_points = excluded.max_points, updated_at = excluded.updated_at${fileSetClause}
       RETURNING id`
    )
      .bind(
        id,
        body.courseWorkId,
        body.mode,
        body.instructions ?? null,
        body.rubricItems ? JSON.stringify(body.rubricItems) : null,
        body.answerKey ?? null,
        fileName,
        fileMime,
        fileExtractedText,
        fileR2Key,
        body.maxPoints,
        now,
        now
      )
      .first<{ id: string }>();
  } catch (e) {
    // DB 沒寫成功，剛放進 R2 的新檔就沒人指到了，刪掉
    if (fileR2Key) await c.env.ATTACHMENTS.delete(fileR2Key).catch(() => {});
    throw e;
  }

  if (oldR2Key && oldR2Key !== fileR2Key) {
    // 舊檔刪不掉只是多佔一點空間，不影響這次儲存
    await c.env.ATTACHMENTS.delete(oldR2Key).catch((e) => console.error("[rubrics] 舊答案檔刪除失敗", oldR2Key, e));
  }

  return c.json({ id: saved?.id ?? id });
});
