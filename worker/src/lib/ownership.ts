import type { Env } from "../types";

/**
 * 多老師共用同一個 D1，任何用 courseId/courseWorkId/submissionId 存取資料的路由，
 * 都要先證明「這筆資料是不是這個老師教的課」，不然登入的老師 A 換個 id 就能看/改老師 B 班上的資料。
 * 判斷依據是 course_teachers（協同教學的課會有多位老師，全部都算數）：
 * 老師按「同步課程」時，Classroom 用 teacherId=me 查得到才會寫進這張表，等於 Google 幫我們驗證過身分。
 * 三支各自對應 courses / coursework / submissions 三種 id，找不到資料或不是自己教的一律回 false。
 */

export async function ownsCourse(env: Env, teacherId: string, courseId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM course_teachers WHERE course_id = ? AND teacher_id = ?")
    .bind(courseId, teacherId)
    .first();
  return !!row;
}

export async function ownsCourseWork(env: Env, teacherId: string, courseWorkId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM coursework cw JOIN course_teachers ct ON ct.course_id = cw.course_id
     WHERE cw.id = ? AND ct.teacher_id = ?`
  )
    .bind(courseWorkId, teacherId)
    .first();
  return !!row;
}

export async function ownsSubmission(env: Env, teacherId: string, submissionId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN course_teachers ct ON ct.course_id = cw.course_id
     WHERE s.id = ? AND ct.teacher_id = ?`
  )
    .bind(submissionId, teacherId)
    .first();
  return !!row;
}
