import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";

// v1.21.0 常用評語庫：老師自己存的短句，批改時點一下插進評語欄
export const phraseRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
phraseRoutes.use("*", requireAuth);

export const MAX_PHRASES = 30;
const createSchema = z.object({ text: z.string().trim().min(1, "句子不能是空的").max(120, "句子最多 120 個字") });

phraseRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, text FROM teacher_phrases WHERE teacher_id = ? ORDER BY created_at ASC")
    .bind(c.get("teacherId"))
    .all<{ id: string; text: string }>();
  return c.json({ phrases: rows.results });
});

phraseRoutes.post("/", async (c) => {
  const teacherId = c.get("teacherId");
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "資料格式不對" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM teacher_phrases WHERE teacher_id = ?").bind(teacherId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PHRASES) return c.json({ error: `最多存 ${MAX_PHRASES} 句，先刪掉不用的再新增` }, 400);
  const dup = await c.env.DB.prepare("SELECT id FROM teacher_phrases WHERE teacher_id = ? AND text = ?").bind(teacherId, parsed.data.text).first<{ id: string }>();
  if (dup) return c.json({ id: dup.id, text: parsed.data.text });
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO teacher_phrases (id, teacher_id, text, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, teacherId, parsed.data.text, Math.floor(Date.now() / 1000))
    .run();
  return c.json({ id, text: parsed.data.text });
});

phraseRoutes.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM teacher_phrases WHERE id = ? AND teacher_id = ?").bind(c.req.param("id"), c.get("teacherId")).run();
  if (r.meta.changes === 0) return c.json({ error: "找不到這句，或不屬於你" }, 404);
  return c.json({ ok: true });
});
