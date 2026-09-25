import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { getValidAccessToken } from "../lib/tokens";
import { z } from "zod";
import { ClassroomError, createCourseWork, listCourses, listCourseWork } from "../lib/classroom";
import { ownsCourse } from "../lib/ownership";
import { watchCourseWork } from "../lib/sync";
import { teacherCanWrite } from "../lib/writeback";

export const courseRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
courseRoutes.use("*", requireAuth);

// 從 Classroom 拉最新課程清單，順便快取進 D1
// 協同教學：Classroom 用 teacherId=me 查，回得來就代表這個人是這門課的老師，所以每位老師同步時
// 都在 course_teachers 加自己一筆，之後的權限判斷看那張表（courses.teacher_id 只留第一個同步的人當紀錄）
courseRoutes.get("/", async (c) => {
  const teacherId = c.get("teacherId");
  const accessToken = await getValidAccessToken(c.env, teacherId);
  const courses = await listCourses(accessToken);

  const now = Math.floor(Date.now() / 1000);
  const statements = courses.flatMap((course) => [
    c.env.DB.prepare(
      `INSERT INTO courses (id, teacher_id, name, section, synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, section = excluded.section, synced_at = excluded.synced_at`
    ).bind(course.id, teacherId, course.name, course.section ?? null, now),
    c.env.DB.prepare(
      `INSERT INTO course_teachers (course_id, teacher_id, added_at) VALUES (?, ?, ?)
       ON CONFLICT(course_id, teacher_id) DO NOTHING`
    ).bind(course.id, teacherId, now),
  ]);
  if (statements.length) await c.env.DB.batch(statements);

  // teacherCount：這門課在 classAI 裡有幾位老師用過，>1 時前端會提醒「分數是共用的」
  const counts = await c.env.DB.prepare(
    `SELECT ct.course_id AS id, COUNT(*) AS n FROM course_teachers ct
     JOIN course_teachers mine ON mine.course_id = ct.course_id AND mine.teacher_id = ?
     GROUP BY ct.course_id`
  )
    .bind(teacherId)
    .all<{ id: string; n: number }>();
  const countById = new Map(counts.results.map((r) => [r.id, r.n]));

  return c.json({ courses: courses.map((course) => ({ ...course, teacherCount: countById.get(course.id) ?? 1 })) });
});

// 某課程底下的作業清單
courseRoutes.get("/:courseId/coursework", async (c) => {
  const teacherId = c.get("teacherId");
  const courseId = c.req.param("courseId");
  if (!(await ownsCourse(c.env, teacherId, courseId))) {
    return c.json({ error: "找不到這門課，或不屬於你（請先在課程列表頁同步一次）" }, 404);
  }

  const accessToken = await getValidAccessToken(c.env, teacherId);
  const canWrite = await teacherCanWrite(c.env, teacherId);
  const courseWork = await listCourseWork(accessToken, courseId, { includeClassaiDrafts: canWrite });

  const now = Math.floor(Date.now() / 1000);
  const statements = courseWork.flatMap((cw) => [
    c.env.DB.prepare(
      `INSERT INTO coursework (id, course_id, title, description, max_points, synced_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
         max_points = excluded.max_points, synced_at = excluded.synced_at`
    ).bind(cw.id, courseId, cw.title, cw.description ?? null, cw.maxPoints ?? 100, now),
    // 能不能送分數回 Classroom：以 Google 回的 associatedWithDeveloper 為準
    c.env.DB.prepare(
      `INSERT INTO coursework_writeback (coursework_id, can_write_back, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(coursework_id) DO UPDATE SET can_write_back = excluded.can_write_back, updated_at = excluded.updated_at`
    ).bind(cw.id, cw.associatedWithDeveloper ? 1 : 0, now),
  ]);
  if (statements.length) await c.env.DB.batch(statements);

  return c.json({ courseWork, canWrite });
});

const newCourseWorkBody = z.object({
  title: z.string().trim().min(1, "請填作業標題").max(200, "標題最多 200 字"),
  description: z.string().max(5000, "說明最多 5000 字").optional(),
  maxPoints: z.number().int("滿分請填整數").min(1, "滿分至少 1 分").max(1000, "滿分最多 1000 分"),
  publish: z.boolean(),
  due: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "截止日期格式不對"),
      time: z.string().regex(/^\d{2}:\d{2}$/, "截止時間格式不對").optional(),
    })
    .optional(),
});

// v1.18.0 在 classAI 出作業：建在老師的 Classroom 課程裡，之後分數才能送回 Classroom（Google 只讓建立者寫分數）
courseRoutes.post("/:courseId/coursework", async (c) => {
  const teacherId = c.get("teacherId");
  const courseId = c.req.param("courseId");
  if (!(await ownsCourse(c.env, teacherId, courseId))) {
    return c.json({ error: "找不到這門課，或不屬於你（請先在課程列表頁同步一次）" }, 404);
  }
  const parsed = newCourseWorkBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "資料格式不對" }, 400);
  const body = parsed.data;
  if (body.due && new Date(`${body.due.date}T${body.due.time ?? "23:59"}:00+08:00`).getTime() < Date.now()) {
    return c.json({ error: "截止時間已經過了，請選之後的時間" }, 400);
  }
  if (!(await teacherCanWrite(c.env, teacherId))) {
    return c.json({ error: "要先允許 classAI 在 Classroom 建立作業", code: "need_write_scope" }, 403);
  }

  const accessToken = await getValidAccessToken(c.env, teacherId);
  let created;
  try {
    created = await createCourseWork(accessToken, courseId, body);
  } catch (e) {
    if (e instanceof ClassroomError && e.status === 403) {
      console.warn("[coursework/create] 403", e.message);
      return c.json({ error: "要先允許 classAI 在 Classroom 建立作業", code: "need_write_scope" }, 403);
    }
    throw e;
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO coursework (id, course_id, title, description, max_points, synced_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(created.id, courseId, created.title, created.description ?? null, created.maxPoints ?? body.maxPoints, now),
    c.env.DB.prepare(
      `INSERT INTO coursework_writeback (coursework_id, can_write_back, created_by_classai_at, updated_at) VALUES (?, 1, ?, ?)
       ON CONFLICT(coursework_id) DO UPDATE SET can_write_back = 1, created_by_classai_at = excluded.created_by_classai_at`
    ).bind(created.id, now, now),
  ]);
  // 建好就交給背景自動預批（還沒設評分標準前排程會略過，設好就開始）
  await watchCourseWork(c.env, teacherId, created.id);

  return c.json({ courseWork: { ...created, associatedWithDeveloper: true } });
});
