import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { ownsCourseWork } from "../lib/ownership";
import { extractExcelText } from "../lib/excel";

export const rubricRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
rubricRoutes.use("*", requireAuth);

const rubricItemSchema = z.object({
  item: z.string(),
  maxPoints: z.number(),
  description: z.string().optional(),
});

// 8MB 原始檔案上限（base64 字串長度約是原始位元組的 4/3 倍），擋過大檔案塞爆 D1 那一列
const MAX_ANSWER_KEY_FILE_BYTES = 8 * 1024 * 1024;
const EXCEL_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
];
const ALLOWED_ANSWER_KEY_FILE_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf", ...EXCEL_MIME_TYPES];

const answerKeyFileSchema = z.object({
  name: z.string(),
  mimeType: z.enum(ALLOWED_ANSWER_KEY_FILE_MIME as [string, ...string[]]),
  base64: z.string(),
});

const upsertSchema = z.object({
  courseWorkId: z.string(),
  mode: z.enum(["freetext", "rubric", "answer_key"]),
  instructions: z.string().optional(),
  rubricItems: z.array(rubricItemSchema).optional(),
  answerKey: z.string().optional(),
  // 都沒帶＝這次沒換答案檔，維持資料庫裡原本存的（不管是有檔案還是沒檔案）
  answerKeyFile: answerKeyFileSchema.optional(),
  removeAnswerKeyFile: z.boolean().optional(),
  maxPoints: z.number().default(100),
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
  if (!row) return c.json({ rubric: null });
  return c.json({
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

rubricRoutes.post("/", async (c) => {
  const teacherId = c.get("teacherId");
  const body = upsertSchema.parse(await c.req.json());
  if (!(await ownsCourseWork(c.env, teacherId, body.courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }

  // 三種情況：換新檔案／明確移除／兩者都沒帶（這次沒動檔案，UPDATE時完全不碰檔案欄位，維持原樣）
  let fileName: string | null = null;
  let fileMime: string | null = null;
  let fileBase64: string | null = null;
  let fileExtractedText: string | null = null;
  const touchFileColumns = !!body.answerKeyFile || !!body.removeAnswerKeyFile;

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
        return c.json({ error: `Excel 檔案解析失敗，請確認檔案沒有損壞：${(e as Error).message}` }, 400);
      }
    } else {
      fileBase64 = body.answerKeyFile.base64;
    }
  }
  // body.removeAnswerKeyFile 時 fileName/fileMime/fileBase64/fileExtractedText 保持 null，
  // 剛好就是「清空檔案」要寫回去的值

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  // 檔案欄位只有真的要換/移除時才出現在 SET 子句裡，這次沒動檔案就完全不觸碰那四欄
  const fileSetClause = touchFileColumns
    ? ", answer_key_file_name = excluded.answer_key_file_name, answer_key_file_mime = excluded.answer_key_file_mime, answer_key_file_base64 = excluded.answer_key_file_base64, answer_key_file_extracted_text = excluded.answer_key_file_extracted_text"
    : "";

  // ON CONFLICT時原本的id不會被覆蓋，用RETURNING拿真正存在DB裡的那個id（不是id這個變數，
  // 那個只在真的新建立時才會派上用場）
  const saved = await c.env.DB.prepare(
    `INSERT INTO rubrics (id, coursework_id, mode, instructions, rubric_json, answer_key, answer_key_file_name, answer_key_file_mime, answer_key_file_base64, answer_key_file_extracted_text, max_points, created_at, updated_at)
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
      fileBase64,
      fileExtractedText,
      body.maxPoints,
      now,
      now
    )
    .first<{ id: string }>();

  return c.json({ id: saved?.id ?? id });
});
