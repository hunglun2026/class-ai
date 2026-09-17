const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

// code==="auth_expired"：Google 授權過期（測試中App的refresh_token約7天到期），
// 畫面上要給「重新登入」按鈕，不是當成一般錯誤只顯示文字
export class ApiError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `請求失敗（${res.status}）`, body.code);
  }
  return res.json();
}

/**
 * 走跟其他 API 同一條 fetch（帶 cookie）把檔案抓成 Blob 再存檔。
 * 不用 <a href> 直連 Worker：那是跨網域整頁跳轉，正式環境不一定帶得到
 * 登入 cookie，失敗時老師還會被丟到一頁純 JSON 錯誤訊息。
 */
async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `下載失敗（${res.status}）`);
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

  courses: () => request<{ courses: { id: string; name: string; section?: string }[] }>("/api/courses"),
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

  getRubric: (courseWorkId: string) => request<{ rubric: any | null }>(`/api/rubrics/${courseWorkId}`),
  saveRubric: (body: object) => request<{ id: string }>("/api/rubrics", { method: "POST", body: JSON.stringify(body) }),

  // 重的：真的去打 Classroom API 拉最新繳交＋全班名冊，只在老師按「拉取最新繳交」時呼叫
  syncSubmissions: (courseId: string, courseWorkId: string) =>
    request<{ submissions: any[] }>(`/api/submissions/${courseId}/${courseWorkId}/sync`, { method: "POST" }),
  // 輕的：只讀 D1 快取，評分完刷新畫面用這支，不要每評一個人就整班重拉一次
  listSubmissions: (courseWorkId: string) =>
    request<{ submissions: any[] }>(`/api/submissions/${courseWorkId}`),
  aiGrade: (submissionId: string) =>
    request<{
      grade: { score: number; feedback: string; itemScores?: { item: string; score: number; comment: string }[] };
      model: string;
    }>(`/api/submissions/${submissionId}/ai-grade`, { method: "POST" }),
  downloadExport: (courseWorkId: string) =>
    downloadFile(`/api/submissions/${courseWorkId}/export.xlsx`, "成績表.xlsx"),
  updateGrade:(submissionId: string, body: { finalScore: number; finalFeedback: string; confirm: boolean }) =>
    request(`/api/submissions/${submissionId}/grade`, { method: "PATCH", body: JSON.stringify(body) }),
};
