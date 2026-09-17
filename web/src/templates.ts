// 常見作業的評分範本：老師最怕從空白開始寫，一鍵帶入再微調。
// 配分是「占總分的比例」，帶入時依作業實際總分換算，加總一定剛好等於總分。

export interface GradingTemplate {
  key: string;
  label: string;
  instructions: string;
  items: { item: string; weight: number }[];
}

export const TEMPLATES: GradingTemplate[] = [
  {
    key: "essay",
    label: "作文",
    instructions: "請依立意取材、結構組織、遣詞造句與錯別字評分，先肯定做得好的地方，再給一個具體的修改建議。",
    items: [
      { item: "立意與內容", weight: 40 },
      { item: "結構與段落", weight: 30 },
      { item: "用詞與錯別字", weight: 30 },
    ],
  },
  {
    key: "reading",
    label: "閱讀心得",
    instructions: "看學生是否讀懂文章重點，並連結自己的生活經驗寫出想法，不要只是重述故事內容。",
    items: [
      { item: "讀懂文章重點", weight: 40 },
      { item: "自己的想法與連結", weight: 40 },
      { item: "文字表達", weight: 20 },
    ],
  },
  {
    key: "worksheet",
    label: "學習單",
    instructions: "檢查答案的觀念是否正確，簡答題是否把原因說清楚，指出觀念錯誤的地方。",
    items: [
      { item: "觀念正確", weight: 50 },
      { item: "說明完整", weight: 30 },
      { item: "書寫用心", weight: 20 },
    ],
  },
  {
    key: "math",
    label: "數學計算題",
    instructions: "檢查最後答案是否正確，並依計算過程給部分分數，明確指出是哪一步算錯。",
    items: [
      { item: "答案正確", weight: 40 },
      { item: "計算過程", weight: 40 },
      { item: "算式書寫", weight: 20 },
    ],
  },
  {
    key: "english",
    label: "英文寫作",
    instructions: "檢查文法、拼字與句型，指出錯誤並附上正確寫法，內容要切題。",
    items: [
      { item: "文法與句型", weight: 40 },
      { item: "單字與拼字", weight: 30 },
      { item: "內容切題", weight: 30 },
    ],
  },
  {
    key: "project",
    label: "專題報告",
    instructions: "看研究問題是否清楚、資料是否有根據、結論是否合理，並檢查有沒有註明資料來源。",
    items: [
      { item: "研究問題", weight: 30 },
      { item: "資料與分析", weight: 40 },
      { item: "結論與反思", weight: 30 },
    ],
  },
];

/** 依比例把總分分給各項，四捨五入後的差額補到最後一項，加總保證等於 total */
export function splitPoints(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const pts = weights.map((w) => Math.round((w / sum) * total));
  const diff = total - pts.reduce((a, b) => a + b, 0);
  if (pts.length) pts[pts.length - 1] += diff;
  return pts;
}
