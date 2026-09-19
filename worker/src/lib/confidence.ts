import type { AiGradeResult, Rubric } from "../types";

// 十輪功能討論MVP最後一項：簡版可信度提示。ChatGPT在討論裡否決了Gemini自評信心
// （模型自己說「我有90%信心」不可信），改成後端算的heuristic規則，只做兩條最有把握、
// 不用額外資料（不用Z-score、不用歷史分數分布）就能判斷的規則。
export function computeConfidenceFlags(rubric: Rubric, result: AiGradeResult): string[] {
  const flags: string[] = [];

  if (rubric.mode === "rubric") {
    const expected = rubric.rubricJson ?? [];
    const got = result.itemScores ?? [];
    const gotItems = new Set(got.map((it) => it.item));
    const missing = expected.filter((it) => !gotItems.has(it.item));
    if (missing.length > 0) {
      flags.push(`AI 沒有針對全部評分項目給分：缺「${missing.map((it) => it.item).join("、")}」`);
    }
  }

  if (result.score === 0 || result.score === rubric.maxPoints) {
    flags.push(result.score === 0 ? "AI 給了 0 分，建議確認是不是誤判" : "AI 給了滿分，建議確認是不是誤判");
  }

  return flags;
}

// 學生內容裡「對 AI 下指令」的常見句型。刻意寫窄：只抓針對評分系統的說法，
// 一般作文裡的「不要忽略細節」「我希望考好」不會命中。AI 自己的判斷（injectionSuspected）
// 另外一層，兩者任一成立就警示，後端規則不怕模型被說服。
const INJECTION_PATTERNS: RegExp[] = [
  /給(我|這份|本份|這題|本題|他|她)?\s*(打)?\s*滿分/,
  /(直接|一律|都)\s*給\s*(10|十|100|一百|滿)\s*分/,
  /(忽略|無視|不要理會|不用理會)(以上|前面|上面|上述|之前|先前|所有|原本)(的)?(指示|指令|規則|設定|要求|評分)/,
  /(系統|評分系統)\s*(通知|指示|公告|訊息)/,
  /(給|對|致)\s*AI\s*(評分系統|系統|助理)?\s*(的)?\s*(指示|指令|通知)/i,
  /AI\s*(請|要)\s*(注意|直接|給|改)/i,
  /老師(已|已經)\s*(人工)?\s*(審核|確認|認定|同意|批准)/,
  /老師備註/,
  /評分(指令|規則|標準)\s*(已)?\s*(更新|變更|修改|改為)/,
  /(從現在(開始|起)|現在開始)\s*你(是|就是|要扮演|扮演)/,
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /(disregard|override)\s+(all\s+)?(the\s+)?(previous|above|system)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /"score"\s*:\s*\d+/,
];

export function detectInjection(texts: string[]): boolean {
  return texts.some((t) => !!t && INJECTION_PATTERNS.some((re) => re.test(t)));
}

// AI 回報或後端規則任一命中就給一條警示（不重複）；沒有就回 null
export function injectionFlag(result: AiGradeResult, studentTexts: string[]): string | null {
  return result.injectionSuspected || detectInjection(studentTexts)
    ? "作答內容疑似在對 AI 下指令（例如要求給滿分），這個分數請自己看過作業再確認"
    : null;
}
