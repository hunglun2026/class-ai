import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { getValidAccessToken } from "../lib/tokens";
import { listCourses, listCourseWork } from "../lib/classroom";
import { ownsCourse } from "../lib/ownership";

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
  const courseWork = await listCourseWork(accessToken, courseId);

  const now = Math.floor(Date.now() / 1000);
  const statements = courseWork.map((cw) =>
    c.env.DB.prepare(
      `INSERT INTO coursework (id, course_id, title, description, max_points, synced_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
         max_points = excluded.max_points, synced_at = excluded.synced_at`
    ).bind(cw.id, courseId, cw.title, cw.description ?? null, cw.maxPoints ?? 100, now)
  );
  if (statements.length) await c.env.DB.batch(statements);

  return c.json({ courseWork });
});
