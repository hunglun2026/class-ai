const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

// code==="auth_expired"：Google 授權過期（測試中App的refresh_token約7天到期），
// 畫面上要給「重新登入」按鈕，不是當成一般錯誤只顯示文字
export class ApiError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

const NETWORK_ERROR = "連不上伺服器，請檢查網路後再試一次";

// 登入過期（session 14 天、Google 授權過期）：通知 App 統一跳回登入頁，不讓每一頁各自只顯示一行字
export const AUTH_LOST_EVENT = "classai:auth-lost";
function checkAuthLost(status: number, code?: string, message?: string) {
  if (status === 401 && (code === "not_logged_in" || code === "auth_expired")) {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: message }));
  }
}

async function send(path: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, { ...options, credentials: "include" });
  } catch {
    // fetch 本身丟錯＝根本沒連上（斷網、伺服器掛了），瀏覽器給的是英文 Failed to fetch
    throw new ApiError(NETWORK_ERROR, "network");
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await send(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.error ?? `請求失敗（${res.status}），請稍後再試`;
    checkAuthLost(res.status, body.code, message);
    throw new ApiError(message, body.code);
  }
  return res.json();
}

/**
 * 走跟其他 API 同一條 fetch（帶 cookie）把檔案抓成 Blob 再存檔。
 * 不用 <a href> 直連 Worker：那是跨網域整頁跳轉，正式環境不一定帶得到
 * 登入 cookie，失敗時老師還會被丟到一頁純 JSON 錯誤訊息。
 */
async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await send(path, {});
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.error ?? `下載失敗（${res.status}），請稍後再試`;
    checkAuthLost(res.status, body.code, message);
    throw new ApiError(message, body.code);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFromHeader(res.headers.get("Content-Disposition")) ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function filenameFromHeader(header: string | null): string | undefined {
  const match = header?.match(/filename\*=UTF-8''([^;]+)/i);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export const api = {
  loginUrl: () => `${API_BASE}/api/auth/google/login`,
  me: () => request<{ teacher: { id: string; email: string; name: string; picture?: string } | null }>("/api/auth/me"),
  logout: () => request("/api/auth/logout", { method: "POST" }),

  // teacherCount：這門課在 classAI 裡有幾位老師（協同教學時 > 1，批改頁會提醒分數是共用的）
  courses: () =>
    request<{ courses: { id: string; name: string; section?: string; teacherCount?: number }[] }>("/api/courses"),
  courseWork: (courseId: string) =>
    request<{
      courseWork: {
        id: string;
        title: string;
        maxPoints?: number;
        dueDate?: { year: number; month: number; day: number };
        dueTime?: { hours?: number; minutes?: number };
        creationTime?: string;
      }[];
    }>(`/api/courses/${courseId}/coursework`),

  // courseworkMaxPoints／gradedCount／maxGivenScore：評分標準頁的防呆提醒用（總分跟 Classroom 不同、已經有人評過分）
  getRubric: (courseWorkId: string) =>
    request<{ rubric: any | null; courseworkMaxPoints: number | null; gradedCount: number; maxGivenScore: number | null }>(
      `/api/rubrics/${courseWorkId}`
    ),
  saveRubric: (body: object) => request<{ id: string }>("/api/rubrics", { method: "POST", body: JSON.stringify(body) }),

  // 重的：真的去打 Classroom API 拉最新繳交＋全班名冊，只在老師按「拉取最新繳交」時呼叫
  syncSubmissions: (courseId: string, courseWorkId: string) =>
    request<{ submissions: any[] }>(`/api/submissions/${courseId}/${courseWorkId}/sync`, { method: "POST" }),
  // 輕的：只讀 D1 快取，評分完刷新畫面用這支，不要每評一個人就整班重拉一次
  listSubmissions: (courseWorkId: string) =>
    request<{ submissions: any[] }>(`/api/submissions/${courseWorkId}`),
  // force：老師改過的分數/評語，確認過要讓 AI 蓋掉才帶（不帶時後端回 code "overwrite_teacher_edit"）
  aiGrade: (submissionId: string, force = false) =>
    request<{
      grade: { score: number; feedback: string; itemScores?: { item: string; score: number; comment: string }[] };
      model: string;
      confidenceFlags: string[];
      remainingToday: number;
    }>(`/api/submissions/${submissionId}/ai-grade${force ? "?force=1" : ""}`, { method: "POST" }),
  // 今天還可以讓 AI 評幾份（每位老師各自計算）
  usage: () => request<{ usedToday: number; dailyLimit: number; remainingToday: number }>("/api/usage"),
  downloadExport: (courseWorkId: string) =>
    downloadFile(`/api/submissions/${courseWorkId}/export.xlsx`, "成績表.xlsx"),
  updateGrade:(submissionId: string, body: { finalScore: number; finalFeedback: string; confirm: boolean }) =>
    request(`/api/submissions/${submissionId}/grade`, { method: "PATCH", body: JSON.stringify(body) }),
  unlockGrade: (submissionId: string) => request(`/api/submissions/${submissionId}/unlock`, { method: "POST" }),
  gradeHistory: (submissionId: string) =>
    request<{
      history: { version_number: number; source: string; score: number | null; feedback: string | null; changed_at: number }[];
    }>(`/api/submissions/${submissionId}/history`),

  // 老師自己存的常用評分標準（跨作業套用），跟rubrics.ts那個單一作業的評分標準是兩回事
  myRubricTemplates: () =>
    request<{ templates: { id: string; name: string; mode: string; max_points: number; created_at: number }[] }>(
      "/api/rubric-templates"
    ),
  getRubricTemplate: (id: string) => request<{ template: any }>(`/api/rubric-templates/${id}`),
  saveRubricTemplate: (body: object) =>
    request<{ id: string }>("/api/rubric-templates", { method: "POST", body: JSON.stringify(body) }),
  deleteRubricTemplate: (id: string) => request(`/api/rubric-templates/${id}`, { method: "DELETE" }),
};
