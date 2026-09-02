import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";
import { getValidAccessToken } from "../lib/tokens";
import { listCourses, listCourseWork } from "../lib/classroom";
import { ownsCourse } from "../lib/ownership";

export const courseRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
courseRoutes.use("*", requireAuth);

// 從 Classroom 拉最新課程清單，順便快取進 D1
// 注意：courses.id 若剛好被兩位老師共同教授的課程撞到，teacher_id 只認第一個同步的人
// （目前沒做多老師共同班級的資料模型，暫不支援協同教學帳號共用同一門課）
courseRoutes.get("/", async (c) => {
  const teacherId = c.get("teacherId");
  const accessToken = await getValidAccessToken(c.env, teacherId);
  const courses = await listCourses(accessToken);

  const now = Math.floor(Date.now() / 1000);
  const statements = courses.map((course) =>
    c.env.DB.prepare(
      `INSERT INTO courses (id, teacher_id, name, section, synced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, section = excluded.section, synced_at = excluded.synced_at`
    ).bind(course.id, teacherId, course.name, course.section ?? null, now)
  );
  if (statements.length) await c.env.DB.batch(statements);

  return c.json({ courses });
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
