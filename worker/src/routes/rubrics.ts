import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { ownsCourseWork } from "../lib/ownership";

export const rubricRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
rubricRoutes.use("*", requireAuth);

const rubricItemSchema = z.object({
  item: z.string(),
  maxPoints: z.number(),
  description: z.string().optional(),
});

const upsertSchema = z.object({
  courseWorkId: z.string(),
  mode: z.enum(["freetext", "rubric", "answer_key"]),
  instructions: z.string().optional(),
  rubricItems: z.array(rubricItemSchema).optional(),
  answerKey: z.string().optional(),
  maxPoints: z.number().default(100),
});

// 一份作業目前只設定一套評分規則，取代式儲存（新建立就覆蓋舊的）
rubricRoutes.get("/:courseWorkId", async (c) => {
  const teacherId = c.get("teacherId");
  const courseWorkId = c.req.param("courseWorkId");
  if (!(await ownsCourseWork(c.env, teacherId, courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  const row = await c.env.DB.prepare("SELECT * FROM rubrics WHERE coursework_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(courseWorkId)
    .first();
  if (!row) return c.json({ rubric: null });
  return c.json({
    rubric: {
      ...row,
      rubricJson: row.rubric_json ? JSON.parse(row.rubric_json as string) : null,
    },
  });
});

rubricRoutes.post("/", async (c) => {
  const teacherId = c.get("teacherId");
  const body = upsertSchema.parse(await c.req.json());
  if (!(await ownsCourseWork(c.env, teacherId, body.courseWorkId))) {
    return c.json({ error: "找不到這份作業，或不屬於你" }, 404);
  }
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO rubrics (id, coursework_id, mode, instructions, rubric_json, answer_key, max_points, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.courseWorkId,
      body.mode,
      body.instructions ?? null,
      body.rubricItems ? JSON.stringify(body.rubricItems) : null,
      body.answerKey ?? null,
      body.maxPoints,
      now,
      now
    )
    .run();

  return c.json({ id });
});
