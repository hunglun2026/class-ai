import type { Env } from "../types";
import { decrypt } from "./crypto";
import { refreshAccessToken } from "./google-oauth";

/**
 * 取得該老師目前可用的 access token。
 * 存在 D1 的 access_token 若還沒過期就直接用，過期或沒存就用 refresh_token 換新的，
 * 換到新的之後寫回 D1（下次不用再換）。
 */
export async function getValidAccessToken(env: Env, teacherId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT access_token, access_token_expires_at, refresh_token FROM teachers WHERE id = ?"
  )
    .bind(teacherId)
    .first<{ access_token: string | null; access_token_expires_at: number | null; refresh_token: string }>();

  if (!row) throw new Error("找不到這位老師的授權紀錄，請重新登入");

  const now = Math.floor(Date.now() / 1000);
  if (row.access_token && row.access_token_expires_at && row.access_token_expires_at - 60 > now) {
    return row.access_token;
  }

  const refreshToken = await decrypt(env.SESSION_SECRET, row.refresh_token);
  const { accessToken, expiresIn } = await refreshAccessToken(env, refreshToken);
  const expiresAt = now + expiresIn;

  await env.DB.prepare(
    "UPDATE teachers SET access_token = ?, access_token_expires_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(accessToken, expiresAt, now, teacherId)
    .run();

  return accessToken;
}
