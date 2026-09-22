import type { Env } from "../types";
import { ownsCourse } from "./ownership";

// 這三個是 MCP 專用的新查詢：跨作業/跨課程條件篩選，Classroom 網頁介面本身做不到
// （網頁只能一個作業一個作業點開看分數）。全部先用 ownsCourse() 檔掉不是這位老師教的課，
// 跟現有網頁 API（src/routes/courses.ts 等）共用同一套授權邏輯，不另外發明。

export interface LowScoringRow {
  studentName: string;
  courseworkTitle: string;
  score: number;
}

export async function listLowScoringStudents(
  env: Env,
  teacherId: string,
  courseId: string,
  threshold: number
): Promise<LowScoringRow[]> {
  if (!(await ownsCourse(env, teacherId, courseId))) return [];
  const rows = await env.DB.prepare(
    `SELECT s.student_name AS studentName, cw.title AS courseworkTitle, g.final_score AS score
     FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN grades g ON g.submission_id = s.id
     WHERE cw.course_id = ? AND g.final_score IS NOT NULL AND g.final_score < ?
     ORDER BY g.final_score ASC`
  )
    .bind(courseId, threshold)
    .all<LowScoringRow>();
  return rows.results;
}

export interface ScoreTrendRow {
  courseworkTitle: string;
  score: number;
  gradedAt: number;
}

export async function getStudentScoreTrend(
  env: Env,
  teacherId: string,
  courseId: string,
  studentName: string
): Promise<ScoreTrendRow[]> {
  if (!(await ownsCourse(env, teacherId, courseId))) return [];
  const rows = await env.DB.prepare(
    `SELECT cw.title AS courseworkTitle, g.final_score AS score, g.graded_at AS gradedAt
     FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN grades g ON g.submission_id = s.id
     WHERE cw.course_id = ? AND s.student_name = ? AND g.final_score IS NOT NULL
     ORDER BY g.graded_at ASC`
  )
    .bind(courseId, studentName)
    .all<ScoreTrendRow>();
  return rows.results;
}

export interface FeedbackMatchRow {
  studentName: string;
  courseworkTitle: string;
  feedback: string;
  score: number;
}

export async function searchFeedback(
  env: Env,
  teacherId: string,
  courseId: string,
  keyword: string
): Promise<FeedbackMatchRow[]> {
  if (!(await ownsCourse(env, teacherId, courseId))) return [];
  const rows = await env.DB.prepare(
    `SELECT s.student_name AS studentName, cw.title AS courseworkTitle,
            g.final_feedback AS feedback, g.final_score AS score
     FROM submissions s
     JOIN coursework cw ON cw.id = s.coursework_id
     JOIN grades g ON g.submission_id = s.id
     WHERE cw.course_id = ? AND g.final_feedback LIKE ?
     ORDER BY g.graded_at DESC
     LIMIT 50`
  )
    .bind(courseId, `%${keyword}%`)
    .all<FeedbackMatchRow>();
  return rows.results;
}
