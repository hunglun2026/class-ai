/**
 * v1.18.0 同學作答雷同提醒：文字作答兩兩比對，找出高度相似的同學，只提醒、不扣分。
 * 在瀏覽器算（全班 40 人約 780 組比對，不佔伺服器運算時間、不花 AI 次數）。
 *
 * 做法：去掉空白標點後切成「連續 3 個字」的片段，算兩人共有片段的比例（Dice 係數）。
 * 中文沒有空格分詞，用字元片段比用詞可靠；只改幾個字、調換句子順序仍然抓得到。
 */

export const SIMILAR_THRESHOLD = 0.8;
// 太短的作答（例如只寫答案）大家本來就會很像，不比
export const MIN_CHARS = 80;
const MAX_CHARS = 4000;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .slice(0, MAX_CHARS);
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let common = 0;
  for (const g of small) if (big.has(g)) common++;
  return (2 * common) / (a.size + b.size);
}

export interface SimilarMatch {
  otherId: string;
  otherName: string;
  percent: number; // 0～100
}

/** 每位學生回傳「最像的那一位」（超過門檻才列）；key 是 submission id */
export function findSimilar(list: { id: string; student_name: string; content_text: string | null }[]): Map<string, SimilarMatch> {
  const prepared = list
    .map((s) => ({ id: s.id, name: s.student_name, text: normalize(s.content_text ?? "") }))
    .filter((s) => s.text.length >= MIN_CHARS)
    .map((s) => ({ ...s, grams: trigrams(s.text) }));

  const best = new Map<string, SimilarMatch>();
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      // 長度差很多就不可能到門檻，省下比對
      const ratio = Math.min(a.grams.size, b.grams.size) / Math.max(a.grams.size, b.grams.size);
      if ((2 * ratio) / (1 + ratio) < SIMILAR_THRESHOLD) continue;
      const score = similarity(a.grams, b.grams);
      if (score < SIMILAR_THRESHOLD) continue;
      const percent = Math.round(score * 100);
      if ((best.get(a.id)?.percent ?? 0) < percent) best.set(a.id, { otherId: b.id, otherName: b.name, percent });
      if ((best.get(b.id)?.percent ?? 0) < percent) best.set(b.id, { otherId: a.id, otherName: a.name, percent });
    }
  }
  return best;
}
