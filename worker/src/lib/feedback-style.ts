import type { Env, FeedbackStyle } from "../types";

/**
 * v1.19.0 評語風格：格式、語氣、長度、老師自己的範例評語，組成評分提示詞裡「評語怎麼寫」那一段。
 * 預設（三段式、溫暖、中等、沒範例）組出來的字串跟 v1.18 以前寫死的一模一樣，沒設定的老師完全不受影響。
 */

export const DEFAULT_STYLE: FeedbackStyle = { format: "three", tone: "warm", length: "medium", samples: [] };
export const MAX_SAMPLES = 3;
export const MAX_SAMPLE_CHARS = 500;

const THREE_DEFAULT =
  "feedback：給學生看的評語，固定三段、每段一到兩句，段落之間換行：【做得好】具體指出一個優點／【可以更好】具體指出最需要改的一點／【下一步】一個學生馬上做得到的動作";

const PER_SECTION = { short: "每段一句", medium: "每段一到兩句", long: "每段兩到三句，可以多引用作答裡的具體句子" };
const ONE_LENGTH = { short: "40 字以內", medium: "80 字以內", long: "150 字以內，可以多引用作答裡的具體句子" };

function formatLine(s: FeedbackStyle): string {
  if (s.format === "three") {
    if (s.length === "medium") return THREE_DEFAULT;
    return `feedback：給學生看的評語，固定三段、${PER_SECTION[s.length]}，段落之間換行：【做得好】具體指出一個優點／【可以更好】具體指出最需要改的一點／【下一步】一個學生馬上做得到的動作`;
  }
  if (s.format === "two") {
    return `feedback：給學生看的評語，固定兩段、${PER_SECTION[s.length]}，段落之間換行：【做得好】具體指出一個優點／【可以更好】具體指出最需要改的一點，並給一個學生馬上做得到的建議`;
  }
  return `feedback：給學生看的評語，寫成一段話（像老師在作業上手寫的短評），${ONE_LENGTH[s.length]}：先肯定一個具體優點，再給一個具體建議；不要分段、不要加【】標題`;
}

const TONE: Record<FeedbackStyle["tone"], string> = {
  warm: "",
  concise: "\n- 評語語氣：簡潔直接，講重點，不說客套話",
  lively: "\n- 評語語氣：活潑親切，像跟學生面對面聊天，可以用一點口語，但不要用 emoji",
};

/** 評分提示詞【輸出】裡 feedback 那一行（含語氣補充） */
export function feedbackInstruction(s: FeedbackStyle = DEFAULT_STYLE): string {
  return `${formatLine(s)}${TONE[s.tone]}`;
}

/** 老師範例評語段落；沒有範例回空字串 */
export function voiceSection(s: FeedbackStyle = DEFAULT_STYLE): string {
  if (!s.samples.length) return "";
  const lines = s.samples.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, " ").trim()}`).join("\n");
  return `\n【這位老師的評語口吻】（老師自己寫過的評語，請模仿用詞、稱呼學生的方式和語氣；內容一定要針對這次學生的作答寫，不要照抄這些句子）\n${lines}\n`;
}

export async function loadFeedbackStyle(env: Env, teacherId: string): Promise<FeedbackStyle> {
  const row = await env.DB.prepare("SELECT format, tone, length, samples_json FROM teacher_feedback_style WHERE teacher_id = ?")
    .bind(teacherId)
    .first<{ format: FeedbackStyle["format"]; tone: FeedbackStyle["tone"]; length: FeedbackStyle["length"]; samples_json: string }>();
  if (!row) return DEFAULT_STYLE;
  let samples: string[] = [];
  try {
    const parsed = JSON.parse(row.samples_json);
    if (Array.isArray(parsed)) samples = parsed.filter((x) => typeof x === "string" && x.trim()).slice(0, MAX_SAMPLES);
  } catch {}
  return { format: row.format, tone: row.tone, length: row.length, samples };
}
