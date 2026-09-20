import type { Env } from "../types";

/**
 * AI 評分的用量上限（每位老師各自算）。
 * - 每天上限存 D1（要留紀錄、之後按學校收費看得到誰用多少）
 * - 每分鐘上限存 KV（每分鐘高頻寫入不適合放 D1），擋連點與程式失控重試
 * 只有「真的打了 Gemini 並成功」才計次，見 routes/submissions.ts。
 */

const DEFAULT_DAILY = 200;
const DEFAULT_PER_MINUTE = 20;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 老師的一天照台灣時間算，不然晚上 8 點（UTC 換日）就重置了
export function taipeiDay(now = Date.now()): string {
  return new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

function limitOf(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface QuotaState {
  ok: boolean;
  reason?: "daily" | "minute";
  usedToday: number;
  dailyLimit: number;
  remainingToday: number;
}

export async function checkAiQuota(env: Env, teacherId: string): Promise<QuotaState> {
  const dailyLimit = limitOf(env.DAILY_AI_LIMIT, DEFAULT_DAILY);
  const perMinute = limitOf(env.MINUTE_AI_LIMIT, DEFAULT_PER_MINUTE);

  const row = await env.DB.prepare("SELECT used FROM ai_usage WHERE teacher_id = ? AND day = ?")
    .bind(teacherId, taipeiDay())
    .first<{ used: number }>();
  const usedToday = row?.used ?? 0;
  const state: QuotaState = {
    ok: true,
    usedToday,
    dailyLimit,
    remainingToday: Math.max(0, dailyLimit - usedToday),
  };
  if (usedToday >= dailyLimit) return { ...state, ok: false, reason: "daily" };

  // 這一分鐘打了幾次（KV 不保證完全精準，用來擋連點夠用）
  const minuteKey = `ratelimit:${teacherId}:${Math.floor(Date.now() / 60_000)}`;
  const inMinute = Number((await env.SESSIONS.get(minuteKey)) ?? "0");
  if (inMinute >= perMinute) return { ...state, ok: false, reason: "minute" };

  return state;
}

export async function recordAiUse(env: Env, teacherId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const day = taipeiDay();
  await env.DB.prepare(
    `INSERT INTO ai_usage (teacher_id, day, used, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(teacher_id, day) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`
  )
    .bind(teacherId, day, now)
    .run();

  const minuteKey = `ratelimit:${teacherId}:${Math.floor(Date.now() / 60_000)}`;
  const inMinute = Number((await env.SESSIONS.get(minuteKey)) ?? "0") + 1;
  await env.SESSIONS.put(minuteKey, String(inMinute), { expirationTtl: 120 });

  const row = await env.DB.prepare("SELECT used FROM ai_usage WHERE teacher_id = ? AND day = ?")
    .bind(teacherId, day)
    .first<{ used: number }>();
  const dailyLimit = limitOf(env.DAILY_AI_LIMIT, DEFAULT_DAILY);
  return Math.max(0, dailyLimit - (row?.used ?? 0));
}
