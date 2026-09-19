import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";

export const rubricTemplateRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
rubricTemplateRoutes.use("*", requireAuth);

const rubricItemSchema = z.object({
  item: z.string(),
  maxPoints: z.number(),
  description: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(60),
  mode: z.enum(["freetext", "rubric", "answer_key"]),
  instructions: z.string().optional(),
  rubricItems: z.array(rubricItemSchema).optional(),
  answerKey: z.string().optional(),
  maxPoints: z.number().default(100),
});

// 老師自己存的常用評分標準，清單只回輕量欄位（不含instructions/rubric_json/answer_key
// 這些內容），列表秒讀；要套用某個範本時前端再打一次 /:id 拿完整內容
rubricTemplateRoutes.get("/", async (c) => {
  const teacherId = c.get("teacherId");
  const rows = await c.env.DB.prepare(
    `SELECT id, name, mode, max_points, created_at FROM rubric_templates
     WHERE teacher_id = ? ORDER BY created_at DESC`
  )
    .bind(teacherId)
    .all();
  return c.json({ templates: rows.results });
});

rubricTemplateRoutes.get("/:id", async (c) => {
  const teacherId = c.get("teacherId");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT id, name, mode, instructions, rubric_json, answer_key, max_points FROM rubric_templates
     WHERE id = ? AND teacher_id = ?`
  )
    .bind(id, teacherId)
    .first<any>();
  if (!row) return c.json({ error: "找不到這個範本，或不屬於你" }, 404);
  return c.json({
    template: {
      ...row,
      rubricJson: row.rubric_json ? JSON.parse(row.rubric_json) : null,
    },
  });
});

rubricTemplateRoutes.post("/", async (c) => {
  const teacherId = c.get("teacherId");
  const body = createSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `INSERT INTO rubric_templates (id, teacher_id, name, mode, instructions, rubric_json, answer_key, max_points, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      teacherId,
      body.name,
      body.mode,
      body.instructions ?? null,
      body.rubricItems ? JSON.stringify(body.rubricItems) : null,
      body.answerKey ?? null,
      body.maxPoints,
      now
    )
    .run();

  return c.json({ id });
});

rubricTemplateRoutes.delete("/:id", async (c) => {
  const teacherId = c.get("teacherId");
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("DELETE FROM rubric_templates WHERE id = ? AND teacher_id = ?")
    .bind(id, teacherId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "找不到這個範本，或不屬於你" }, 404);
  return c.json({ ok: true });
});
