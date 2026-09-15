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
  // 三選一：換新檔案／保留上次存的檔案／明確移除。都沒帶＝這份評分標準沒有檔案。
  answerKeyFile: answerKeyFileSchema.optional(),
  keepAnswerKeyFile: z.boolean().optional(),
  maxPoints: z.number().default(100),
});

// 一份作業目前只設定一套評分規則，取代式儲存（新建立就覆蓋舊的）
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
     FROM rubrics WHERE coursework_id = ? ORDER BY created_at DESC LIMIT 1`
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

  let fileName: string | null = null;
  let fileMime: string | null = null;
  let fileBase64: string | null = null;
  let fileExtractedText: string | null = null;

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
  } else if (body.keepAnswerKeyFile) {
    // 這次沒換檔案，把上一版存的檔案原樣帶到新的一列（取代式儲存，每次存都是新的一列）
    const prev = await c.env.DB.prepare(
      "SELECT answer_key_file_name, answer_key_file_mime, answer_key_file_base64, answer_key_file_extracted_text FROM rubrics WHERE coursework_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(body.courseWorkId)
      .first<{
        answer_key_file_name: string | null;
        answer_key_file_mime: string | null;
        answer_key_file_base64: string | null;
        answer_key_file_extracted_text: string | null;
      }>();
    fileName = prev?.answer_key_file_name ?? null;
    fileMime = prev?.answer_key_file_mime ?? null;
    fileBase64 = prev?.answer_key_file_base64 ?? null;
    fileExtractedText = prev?.answer_key_file_extracted_text ?? null;
  }

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO rubrics (id, coursework_id, mode, instructions, rubric_json, answer_key, answer_key_file_name, answer_key_file_mime, answer_key_file_base64, answer_key_file_extracted_text, max_points, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    .run();

  return c.json({ id });
});
