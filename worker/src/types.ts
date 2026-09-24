export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ATTACHMENTS: R2Bucket;
  ENVIRONMENT: string;
  GOOGLE_REDIRECT_URI: string;
  APP_URL: string;
  // secrets（wrangler secret put）
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GEMINI_API_KEYS: string; // 逗號分隔，多把 key 輪流用、額度用盡自動換下一把
  SESSION_SECRET: string; // 簽 cookie 用
  APP_VERSION: string;
  // AI 評分用量上限（每位老師）：不設就用 usage.ts 的預設（每天 200、每分鐘 20）
  DAILY_AI_LIMIT?: string;
  MINUTE_AI_LIMIT?: string;
  // 背景自動預批每輪（10 分鐘）最多評幾位，不設就 15（lib/autograde.ts）
  AUTOGRADE_PER_RUN?: string;
  // MCP（讓 Claude Desktop / Claude Code 直接呼叫 classAI）用的 OAuth 2.1 提供者：
  // OAUTH_KV 是 @cloudflare/workers-oauth-provider 套件內部要求的固定綁定名稱，
  // 存 client/grant/token，跟給老師網頁登入用的 SESSIONS KV 分開。
  // OAUTH_PROVIDER 不用自己在 wrangler.jsonc 設，是套件包住整支 Worker 後自動注入的。
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

export interface Variables {
  teacherId: string;
}

export interface Rubric {
  id: string;
  courseworkId: string;
  mode: "freetext" | "rubric" | "answer_key";
  instructions?: string | null;
  rubricJson?: RubricItem[] | null;
  answerKey?: string | null;
  answerKeyFile?: { name: string; mimeType: string; base64?: string; extractedText?: string } | null;
  maxPoints: number;
}

export interface RubricItem {
  item: string;
  maxPoints: number;
  description?: string;
}

// 同一份評分標準過去被老師修正過的紀錄，評分時當參考範例拿捏鬆緊（見 lib/calibration.ts）
export interface CalibrationExample {
  studentExcerpt: string;
  aiScore: number;
  teacherFinalScore: number;
  teacherFinalFeedback: string | null;
}

export interface AiGradeResult {
  score: number;
  feedback: string;
  itemScores?: { item: string; score: number; comment: string }[];
  // AI 自己判斷學生內容裡有沒有人在對它下指令（例如要求給滿分）
  injectionSuspected?: boolean;
}
