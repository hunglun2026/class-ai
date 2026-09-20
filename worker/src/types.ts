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
  GEMINI_API_KEY: string;
  SESSION_SECRET: string; // 簽 cookie 用
  APP_VERSION: string;
  // AI 評分用量上限（每位老師）：不設就用 usage.ts 的預設（每天 200、每分鐘 20）
  DAILY_AI_LIMIT?: string;
  MINUTE_AI_LIMIT?: string;
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

export interface AiGradeResult {
  score: number;
  feedback: string;
  itemScores?: { item: string; score: number; comment: string }[];
  // AI 自己判斷學生內容裡有沒有人在對它下指令（例如要求給滿分）
  injectionSuspected?: boolean;
}
