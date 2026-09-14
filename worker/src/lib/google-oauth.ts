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
  if (!res.ok) throw new Error(`Google token 刷新失敗：${res.status} ${await res.text()}`);
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
