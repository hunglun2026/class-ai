import type { Env } from "../types";

// 讀作業要的權限：課程、作業、繳交內容、學生名冊都用唯讀
// Drive readonly 是為了讀附加的 Google 文件/圖片/PDF 內文
export const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

// 少了任何一個就不能用（openid/email/profile 是登入本身，Google 一定會給）
export const REQUIRED_SCOPES = SCOPES.filter((s) => s.startsWith("https://"));

export function buildAuthUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // 每次都要求同意畫面，才拿得到 refresh_token
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token: string;
  scope?: string; // 老師實際勾選同意的權限（空白分隔）
}

export async function exchangeCodeForTokens(env: Env, code: string): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token 交換失敗：${res.status} ${await res.text()}`);
  return res.json();
}

// refresh_token 失效專用的錯誤類別：跟其他 Google API 錯誤分開，讓路由/全域錯誤處理
// 能辨識出「老師要重新登入」跟「暫時性錯誤」的差別，給出看得懂的訊息而不是通用的
// 「系統暫時發生問題」。這個情況真的會發生：測試中狀態的未驗證 App，Google 規定
// refresh_token 大約 7 天就會過期，老師用一陣子後一定會撞到。
export class GoogleAuthExpiredError extends Error {}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    // invalid_grant：refresh_token 過期或被撤銷，只有重新登入救得回來，其他錯誤才算暫時性問題
    if (detail.includes("invalid_grant")) {
      throw new GoogleAuthExpiredError("Google 授權已過期或被取消，請登出後重新登入一次");
    }
    throw new Error(`Google token 刷新失敗：${res.status} ${detail}`);
  }
  const data = await res.json<{ access_token: string; expires_in: number }>();
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export function decodeIdToken(idToken: string): { sub: string; email: string; name: string; picture?: string } {
  const payload = idToken.split(".")[1];
  const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  // atob 只會逐位元組轉成字元，中文這類多位元組 UTF-8 字元（例如 Google 帳號顯示名稱）
  // 直接 JSON.parse 會變亂碼，要先用 TextDecoder 把位元組正確組回 UTF-8 字串再解析
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const json = new TextDecoder("utf-8").decode(bytes);
  return JSON.parse(json);
}
