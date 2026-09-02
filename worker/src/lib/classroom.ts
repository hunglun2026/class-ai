const BASE = "https://classroom.googleapis.com/v1";

async function callClassroom<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Classroom API ${path} 回 ${res.status}：${(await res.text()).slice(0, 300)}`);
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
