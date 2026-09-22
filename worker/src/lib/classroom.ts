const BASE = "https://classroom.googleapis.com/v1";

// 帶狀態碼的錯誤：全域錯誤處理（index.ts）依狀態碼換成老師看得懂的說明，原始內容只進 log
export class ClassroomError extends Error {
  constructor(public status: number, detail: string) {
    super(detail);
  }
}

async function callClassroom<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new ClassroomError(res.status, `Classroom API ${path} 回 ${res.status}：${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/**
 * 跟著 nextPageToken 把整份清單抓完，避免超過 100 筆的班級/課程被無聲截斷。
 * `path` 不含 page token 參數，本函式自己加。
 */
async function paginate<T>(accessToken: string, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = pageToken ? `${path}${sep}pageToken=${encodeURIComponent(pageToken)}` : path;
    const data = await callClassroom<Record<string, unknown>>(accessToken, url);
    out.push(...((data[key] as T[]) ?? []));
    pageToken = data.nextPageToken as string | undefined;
  } while (pageToken);
  return out;
}

export interface ClassroomCourse {
  id: string;
  name: string;
  section?: string;
  courseState: string;
}

export async function listCourses(accessToken: string): Promise<ClassroomCourse[]> {
  return paginate<ClassroomCourse>(accessToken, "/courses?courseStates=ACTIVE&teacherId=me&pageSize=100", "courses");
}

export interface ClassroomCourseWork {
  id: string;
  title: string;
  description?: string;
  maxPoints?: number;
  state: string;
  // Classroom API 原本就會回傳，作業清單要依截止日排序、卡片上顯示截止日
  dueDate?: { year: number; month: number; day: number };
  dueTime?: { hours?: number; minutes?: number };
  creationTime?: string;
}

export async function listCourseWork(accessToken: string, courseId: string): Promise<ClassroomCourseWork[]> {
  return paginate<ClassroomCourseWork>(
    accessToken,
    `/courses/${courseId}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`,
    "courseWork"
  );
}

export interface ClassroomAttachment {
  driveFile?: { id: string; title: string; alternateLink: string };
  link?: { url: string; title?: string };
}

export interface ClassroomSubmission {
  id: string;
  userId: string;
  state: string; // NEW / CREATED / TURNED_IN / RETURNED / RECLAIMED_BY_STUDENT
  assignmentSubmission?: { attachments?: ClassroomAttachment[] };
  shortAnswerSubmission?: { answer?: string };
  // Classroom「選擇題」題型的作答（只有一個選項文字）
  multipleChoiceSubmission?: { answer?: string };
  // 繳交／退回等狀態變化紀錄，用來算「最後一次繳交時間」判斷有沒有重交
  submissionHistory?: { stateHistory?: { state?: string; stateTimestamp?: string } }[];
}

// 最後一次 TURNED_IN 的時間（unix 秒）；沒有紀錄回 null
export function lastTurnedInAt(sub: ClassroomSubmission): number | null {
  let latest: number | null = null;
  for (const h of sub.submissionHistory ?? []) {
    const st = h.stateHistory;
    if (st?.state !== "TURNED_IN" || !st.stateTimestamp) continue;
    const t = Math.floor(Date.parse(st.stateTimestamp) / 1000);
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

export async function listStudentSubmissions(
  accessToken: string,
  courseId: string,
  courseWorkId: string
): Promise<ClassroomSubmission[]> {
  const all = await paginate<ClassroomSubmission>(
    accessToken,
    `/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions?pageSize=100`,
    "studentSubmissions"
  );
  return all.filter((s) => s.state === "TURNED_IN" || s.state === "RETURNED");
}

/**
 * 一次把全班名冊抓回來（userId → 姓名），取代逐個學生打一次 API。
 * 30 人的班級這樣只要 1～2 次請求，不是 30 次——避免拉一次繳交清單就把 Classroom
 * 的配額用掉一大半，也讓「拉取最新繳交」明顯變快。
 * 名冊權限不足（老師沒開 rosters 權限）就回空 Map，呼叫端退回用 userId 頂著。
 */
export async function listStudentsMap(accessToken: string, courseId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const students = await paginate<{ userId: string; profile: { name: { fullName: string } } }>(
      accessToken,
      `/courses/${courseId}/students?pageSize=100`,
      "students"
    );
    for (const s of students) map.set(s.userId, s.profile.name.fullName);
  } catch {
    // 名冊讀不到就交給呼叫端 fallback，不擋整批
  }
  return map;
}

export interface ClassroomRubricLevel {
  id: string;
  title?: string;
  description?: string;
  points?: number;
}

export interface ClassroomRubricCriterion {
  id: string;
  title: string;
  description?: string;
  levels: ClassroomRubricLevel[];
}

export interface ClassroomRubric {
  id: string;
  criteria: ClassroomRubricCriterion[];
}

/**
 * 讀取老師在 Classroom 網頁已經設定好的評分量表（Rubric）——一份作業最多一份。
 * 這是「讀 Classroom 既有量表當主線，classAI 自建量表當 fallback」這個定位的核心：
 * 故意不 throw，讀不到（沒設定量表／API 400/404／權限不足）一律回 null，
 * 呼叫端把它當「這份作業沒有 Classroom 量表」處理，不當成錯誤攔住老師。
 * 唯讀，不需要在既有 SCOPES 之外多要任何權限
 * （courses.courseWork.rubrics.list 吃 classroom.coursework.students.readonly，
 * 這個 scope 我們本來就已經有）。
 */
export async function getClassroomRubric(
  accessToken: string,
  courseId: string,
  courseWorkId: string
): Promise<ClassroomRubric | null> {
  try {
    const data = await callClassroom<{ rubrics?: ClassroomRubric[] }>(
      accessToken,
      `/courses/${courseId}/courseWork/${courseWorkId}/rubrics`
    );
    const rubric = data.rubrics?.[0];
    if (!rubric || !rubric.criteria?.length) return null;
    return rubric;
  } catch (e) {
    // 404（沒設定量表）、400（帳號沒有 rubrics 功能，例如個人 Gmail 帳號）、
    // 403（權限不夠）都算「讀不到」，不算系統錯誤——只在 log 留一筆方便之後排查
    console.warn(`[classroom] 讀 Rubric 失敗（當作沒有量表處理）courseWorkId=${courseWorkId}:`, e);
    return null;
  }
}

/**
 * 把 Classroom Rubric 轉成 classAI 自己的量表格式（rubrics.rubric_json 那個陣列）。
 * Classroom 一個 criterion 有多個 level 各自對應不同分數；classAI 的量表模式是
 * 「一個項目一個配分」，沒有等第概念，所以取每個 criterion 的最高分當這個項目的配分，
 * description 把每個等第的說明串起來，讓 AI 評分時看得到完整的等第描述去判斷該給哪一級。
 */
export function classroomRubricToItems(
  rubric: ClassroomRubric
): { item: string; maxPoints: number; description: string }[] {
  return rubric.criteria.map((c) => {
    const levels = [...c.levels].sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    const maxPoints = levels[0]?.points ?? 0;
    const levelLines = levels
      .map((lv) => `${lv.title ?? ""}${lv.points != null ? `(${lv.points}分)` : ""}：${lv.description ?? ""}`)
      .filter((line) => line.trim().length > 0)
      .join("\n");
    const description = [c.description, levelLines].filter(Boolean).join("\n").trim();
    return { item: c.title, maxPoints, description };
  });
}

/**
 * 把 AI 建議分數寫入 draftGrade（老師專屬看得到，學生看不到）。
 * 目前這次不接這條路——WEB 只在工具內顯示分數，等之後要做「寫回 Classroom」才會呼叫這支。
 * 先留著介面，實作對照官方文件：patch + updateMask=draftGrade。
 */
export async function patchDraftGrade(
  accessToken: string,
  courseId: string,
  courseWorkId: string,
  submissionId: string,
  draftGrade: number
): Promise<void> {
  const res = await fetch(
    `${BASE}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${submissionId}?updateMask=draftGrade`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ draftGrade }),
    }
  );
  if (!res.ok) throw new Error(`寫入 draftGrade 失敗：${res.status} ${await res.text()}`);
}
