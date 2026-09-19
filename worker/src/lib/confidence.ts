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
