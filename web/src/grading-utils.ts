// 批改頁（Grading）與學生卡片（SubmissionCard）共用的型別與純函式

export interface Submission {
  id: string;
  student_id: string;
  student_name: string;
  state: string;
  content_text: string;
  ai_score: number | null;
  ai_feedback: string | null;
  final_score: number | null;
  final_feedback: string | null;
  status: "ai_suggested" | "teacher_edited" | "confirmed" | null;
  ai_model: string | null;
  ai_raw_json: string | null;
  locked: number | null;
  confidence_flags: string | null;
  risk_level: "green" | "yellow" | "red" | null;
  attachments_json: string | null;
  turned_in_at: number | null; // 學生最後一次繳交時間（unix 秒）
  grade_updated_at: number | null; // 分數最後一次變動時間
  autograde_error: string | null; // 背景自動預批時 AI 評不了的原因（v1.17.0），老師要自己批
  pushed_score: number | null; // 已送到 Classroom 的草稿分數（v1.18.0）
  pushed_at: number | null;
}

// AI 評不了、要老師自己批的（老師已經打過分就不算）
export function needsTeacher(s: Submission): string | undefined {
  return s.autograde_error && (!s.status || s.status === "ai_suggested") ? s.autograde_error : undefined;
}

// 學生在老師評分之後又重交：分數是針對舊版本的，要提醒老師重看
export function isResubmitted(s: Submission): boolean {
  return !!s.status && s.turned_in_at != null && s.grade_updated_at != null && s.turned_in_at > s.grade_updated_at;
}

export interface AttachmentLink {
  name: string;
  href: string | null; // null＝網址不安全或沒有，只顯示名稱不做成連結
}

// 只放行 http/https：學生交的連結網址是學生自己填的，javascript: 之類做成連結，老師一點就會執行（XSS）
export function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function parseAttachments(raw: string | null): AttachmentLink[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map((a: { name?: string; url?: string; driveFileId?: string }) => ({
      name: a.name || "未命名檔案",
      // 雲端硬碟檔案：同步時存的原檔連結；舊資料沒存連結就用檔案 ID 組
      href:
        safeHttpUrl(a.url) ??
        (a.driveFileId ? `https://drive.google.com/file/d/${encodeURIComponent(a.driveFileId)}/view` : null),
    }));
  } catch {
    return [];
  }
}

export function parseConfidenceFlags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 跟後端 submissions.ts 的 turnedIn 判斷一致：state 是 Classroom 原始值（NEW/CREATED/
// TURNED_IN/RETURNED/RECLAIMED_BY_STUDENT），不是老師改分的狀態
export function hasTurnedIn(s: Submission): boolean {
  return s.state === "TURNED_IN" || s.state === "RETURNED";
}

export const HISTORY_SOURCE_LABEL: Record<string, string> = {
  AI_INITIAL: "AI 初評",
  AI_REGRADE: "AI 重新評分",
  TEACHER_EDIT: "老師修改",
  TEACHER_CONFIRM: "老師確認定案",
  TEACHER_REOPEN: "老師解鎖重編輯",
};

export function parseItemScores(raw: string | null): { item: string; score: number; comment?: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.itemScores) ? parsed.itemScores : [];
  } catch {
    return [];
  }
}
