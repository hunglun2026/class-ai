import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../middleware";

export const inboxRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
inboxRoutes.use("*", requireAuth);

// 首頁「等你確認」（v1.17.0）：背景自動預批接手中的作業，各有幾位等老師看。
// 協同教學：同一門課的每位老師都看得到（看 course_teachers，不只看當初登記的那位）
inboxRoutes.get("/", async (c) => {
  const teacherId = c.get("teacherId");
  const now = Math.floor(Date.now() / 1000);
  const rows = await c.env.DB.prepare(
    `SELECT cw.id AS courseWorkId, cw.title, cw.max_points AS maxPoints, cw.course_id AS courseId, co.name AS courseName,
       w.last_synced_at AS autoSyncedAt, w.last_error AS lastError,
       COALESCE(SUM(g.status = 'ai_suggested' AND g.risk_level = 'green'), 0) AS green,
       COALESCE(SUM(g.status = 'ai_suggested' AND g.risk_level = 'yellow'), 0) AS yellow,
       COALESCE(SUM(g.status = 'ai_suggested' AND (g.risk_level = 'red' OR g.risk_level IS NULL)), 0) AS red,
       COALESCE(SUM(s.autograde_error IS NOT NULL AND (g.status IS NULL OR g.status = 'ai_suggested')), 0) AS needsTeacher,
       COALESCE(SUM(g.status IN ('teacher_edited', 'confirmed') AND s.turned_in_at > g.updated_at), 0) AS resubmitted
     FROM autograde_watch w
     JOIN coursework cw ON cw.id = w.coursework_id
     JOIN courses co ON co.id = cw.course_id
     JOIN course_teachers ct ON ct.course_id = cw.course_id AND ct.teacher_id = ?
     LEFT JOIN submissions s ON s.coursework_id = cw.id
     LEFT JOIN grades g ON g.submission_id = s.id
     WHERE w.watch_until > ?
     GROUP BY cw.id
     ORDER BY w.last_synced_at DESC`
  )
    .bind(teacherId, now)
    .all<{
      courseWorkId: string;
      title: string;
      maxPoints: number | null;
      courseId: string;
      courseName: string;
      autoSyncedAt: number | null;
      lastError: string | null;
      green: number;
      yellow: number;
      red: number;
      needsTeacher: number;
      resubmitted: number;
    }>();

  // 什麼都不用看的作業不列；授權失效的一定列，老師才知道要重新登入
  const items = rows.results.filter(
    (r) => r.green + r.yellow + r.red + r.needsTeacher + r.resubmitted > 0 || r.lastError === "auth_expired"
  );
  return c.json({ items });
});
