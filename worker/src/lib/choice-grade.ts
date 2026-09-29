/**
 * 選擇題（標準答案是「1.B 2.A 3.C…」這種逐題選項）由程式逐題比對，不交給 AI。
 * 為什麼：AI 數二十題很容易數錯（2026-09-29 實測，學生答對 14／20，AI 給了 45 分），
 * 選擇題有標準答案，程式比對又準又不耗 AI 次數。
 *
 * 只在「很確定是選擇題答案表」時才啟用，其他情況回 null，照舊交給 AI：
 * - 標準答案要能讀出至少 3 題，而且文字大部分都是「題號＋選項」（有長篇解說的答案不算）
 * - 學生作答也要讀得出至少 1 題
 */
import type { AiGradeResult } from "../types";

export const CHOICE_MODEL_LABEL = "程式逐題比對";

const ENTRY = /(\d{1,3})\s*[.、．:：)）\-－]?\s*([A-Ha-h])(?![A-Za-z])/g;

function parse(text: string): { answers: Map<number, string>; coverage: number } {
  const t = text.normalize("NFKC");
  const answers = new Map<number, string>();
  let matched = 0;
  for (const m of t.matchAll(ENTRY)) {
    // 學生改答案時以最後一次寫的為準
    answers.set(Number(m[1]), m[2].toUpperCase());
    matched += m[0].replace(/\s/g, "").length;
  }
  const total = t.replace(/\s/g, "").length || 1;
  return { answers, coverage: matched / total };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const listQ = (qs: number[]) => qs.map((q) => `第 ${q} 題`).join("、");

export function gradeChoiceAnswers(answerKey: string | undefined | null, studentText: string, maxPoints: number): AiGradeResult | null {
  if (!answerKey || !(maxPoints > 0)) return null;
  const key = parse(answerKey);
  if (key.answers.size < 3 || key.coverage < 0.5) return null;
  let stu = parse(studentText);
  if (stu.answers.size === 0) {
    // 學生沒寫題號（只寫「B A C D…」或一行一個字母）：照順序當第 1、2、3 題。
    // 只在整段文字「全都是選項字母」而且數量剛好等於題數時才採信，數量對不上就退回 AI，免得錯位還給分
    const letters = studentText.normalize("NFKC").match(/[A-Ha-h]/g) ?? [];
    const onlyLetters = studentText.normalize("NFKC").replace(/[A-Ha-h\s,、，.;；:：)）\-]/g, "").length === 0;
    if (!onlyLetters || letters.length !== key.answers.size) return null;
    const ordered = new Map<number, string>();
    [...key.answers.keys()].sort((a, b) => a - b).forEach((q, i) => ordered.set(q, letters[i].toUpperCase()));
    stu = { answers: ordered, coverage: 1 };
  }

  const nums = [...key.answers.keys()].sort((a, b) => a - b);
  const wrong: string[] = [];
  const blank: number[] = [];
  let correct = 0;
  for (const q of nums) {
    const want = key.answers.get(q)!;
    const got = stu.answers.get(q);
    if (got === undefined) blank.push(q);
    else if (got === want) correct += 1;
    else wrong.push(`第 ${q} 題（你寫 ${got}，正確是 ${want}）`);
  }
  const score = round1((correct / nums.length) * maxPoints);
  const parts = [`共 ${nums.length} 題，答對 ${correct} 題，得 ${score} 分。`];
  if (wrong.length) parts.push(`答錯：${wrong.join("、")}。`);
  if (blank.length) parts.push(`沒寫：${listQ(blank)}。`);
  if (!wrong.length && !blank.length) parts.push("全部答對，很棒！");
  else parts.push("把錯的題目對照課本再看一次，下次會更好。");
  return { score, feedback: parts.join("\n") };
}
