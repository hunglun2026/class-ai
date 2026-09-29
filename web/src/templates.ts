// 常見作業的評分範本：老師最怕從空白開始寫，一鍵帶入再微調。
// 配分是「占總分的比例」，帶入時依作業實際總分換算，加總一定剛好等於總分。
// 依台灣十二年國教課綱的領域分科，畫面上先選科目再選範本；key 一旦上線就不要改（老師可能記得順序）。

export interface GradingTemplate {
  key: string;
  label: string;
  subject: string;
  instructions: string;
  items: { item: string; weight: number }[];
}

/** 科目順序就是畫面上頁籤的順序；「通用」放最前面，不確定是哪一科的作業從這裡挑 */
export const SUBJECTS = [
  "通用",
  "國語文",
  "英語文",
  "數學",
  "自然科學",
  "社會",
  "藝術",
  "健康與體育",
  "綜合活動",
  "科技與資訊",
  "生活課程",
  "本土語文",
] as const;

export const TEMPLATES: GradingTemplate[] = [
  {
    key: "worksheet",
    label: "學習單",
    subject: "通用",
    instructions: "檢查答案的觀念是否正確，簡答題是否把原因說清楚，指出觀念錯誤的地方。",
    items: [
      { item: "觀念正確", weight: 50 },
      { item: "說明完整", weight: 30 },
      { item: "書寫用心", weight: 20 },
    ],
  },
  {
    key: "project",
    label: "專題報告",
    subject: "通用",
    instructions: "看研究問題是否清楚、資料是否有根據、結論是否合理，並檢查有沒有註明資料來源。",
    items: [
      { item: "研究問題", weight: 30 },
      { item: "資料與分析", weight: 40 },
      { item: "結論與反思", weight: 30 },
    ],
  },
  {
    key: "group",
    label: "小組報告",
    subject: "通用",
    instructions: "看小組成果是否完整切題，分工與合作的說明是否具體，並鼓勵學生說出自己在組內做了什麼。",
    items: [
      { item: "成果完整切題", weight: 40 },
      { item: "分工與合作說明", weight: 30 },
      { item: "表達清楚", weight: 30 },
    ],
  },
  {
    key: "reflection",
    label: "學習心得與反思",
    subject: "通用",
    instructions: "看學生有沒有說出這次學到什麼、遇到什麼困難、下次想怎麼做，鼓勵具體的例子，不要只寫「很有趣」。",
    items: [
      { item: "學到什麼", weight: 40 },
      { item: "困難與解決", weight: 30 },
      { item: "下一步想法", weight: 30 },
    ],
  },
  {
    key: "essay",
    label: "作文",
    subject: "國語文",
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
    subject: "國語文",
    instructions: "看學生是否讀懂文章重點，並連結自己的生活經驗寫出想法，不要只是重述故事內容。",
    items: [
      { item: "讀懂文章重點", weight: 40 },
      { item: "自己的想法與連結", weight: 40 },
      { item: "文字表達", weight: 20 },
    ],
  },
  {
    key: "chinese_qa",
    label: "閱讀理解簡答",
    subject: "國語文",
    instructions: "對照文章檢查學生的回答有沒有找對依據，答案是否完整，指出哪一句話才是題目要的線索。",
    items: [
      { item: "找到文章依據", weight: 40 },
      { item: "答案完整正確", weight: 40 },
      { item: "語句通順", weight: 20 },
    ],
  },
  {
    key: "chinese_words",
    label: "國字注音與語詞",
    subject: "國語文",
    instructions: "檢查國字、注音、語詞解釋是否正確，錯的字請寫出正確寫法，並提醒容易混淆的相似字。",
    items: [
      { item: "國字與注音正確", weight: 50 },
      { item: "語詞解釋與運用", weight: 30 },
      { item: "字跡工整", weight: 20 },
    ],
  },
  {
    key: "chinese_sentence",
    label: "造句與短文",
    subject: "國語文",
    instructions: "看句子是否通順、有沒有用對指定的詞語，短文是否有主題，鼓勵學生把句子寫具體。",
    items: [
      { item: "用對指定詞語", weight: 40 },
      { item: "句子通順完整", weight: 40 },
      { item: "內容具體有趣", weight: 20 },
    ],
  },
  {
    key: "classical",
    label: "文言文與詩詞賞析",
    subject: "國語文",
    instructions: "看學生是否讀懂字詞與句意，能不能說出作者想表達的情感或道理，並用自己的話解釋，不要照抄註解。",
    items: [
      { item: "字詞與句意理解", weight: 40 },
      { item: "情感與主旨掌握", weight: 40 },
      { item: "用自己的話說明", weight: 20 },
    ],
  },
  {
    key: "english",
    label: "英文寫作",
    subject: "英語文",
    instructions: "檢查文法、拼字與句型，指出錯誤並附上正確寫法，內容要切題。",
    items: [
      { item: "文法與句型", weight: 40 },
      { item: "單字與拼字", weight: 30 },
      { item: "內容切題", weight: 30 },
    ],
  },
  {
    key: "english_reading",
    label: "英文閱讀測驗簡答",
    subject: "英語文",
    instructions: "對照文章檢查答案是否正確，簡答要用完整句子，指出學生漏看的關鍵資訊。",
    items: [
      { item: "答案正確", weight: 50 },
      { item: "完整句子與文法", weight: 30 },
      { item: "找到文章依據", weight: 20 },
    ],
  },
  {
    key: "english_vocab",
    label: "單字與句型練習",
    subject: "英語文",
    instructions: "檢查單字拼寫、詞性用法與句型套用是否正確，錯的地方寫出正確答案，並提醒常見拼字錯誤。",
    items: [
      { item: "單字拼寫", weight: 40 },
      { item: "句型與文法運用", weight: 40 },
      { item: "句子意思合理", weight: 20 },
    ],
  },
  {
    key: "math",
    label: "數學計算題",
    subject: "數學",
    instructions: "檢查最後答案是否正確，並依計算過程給部分分數，明確指出是哪一步算錯。",
    items: [
      { item: "答案正確", weight: 40 },
      { item: "計算過程", weight: 40 },
      { item: "算式書寫", weight: 20 },
    ],
  },
  {
    key: "math_word",
    label: "應用題與解題說明",
    subject: "數學",
    instructions: "看學生有沒有讀懂題意、列出合理的算式、寫出單位與答案，並用文字說明解題想法，過程對但算錯要給部分分數。",
    items: [
      { item: "讀懂題意與列式", weight: 35 },
      { item: "計算與答案（含單位）", weight: 40 },
      { item: "解題說明清楚", weight: 25 },
    ],
  },
  {
    key: "math_geometry",
    label: "幾何作圖與證明",
    subject: "數學",
    instructions: "檢查圖形標示是否清楚，每一步推論有沒有理由（定義、性質或定理），指出推理跳太快或理由寫錯的地方。",
    items: [
      { item: "圖形與已知標示", weight: 25 },
      { item: "推理步驟合理", weight: 45 },
      { item: "理由與結論完整", weight: 30 },
    ],
  },
  {
    key: "science_report",
    label: "實驗報告",
    subject: "自然科學",
    instructions: "看實驗目的、方法、數據與結論是否連得起來，變因有沒有控制，結論要根據數據，不能只寫「跟預期一樣」。",
    items: [
      { item: "目的與方法", weight: 25 },
      { item: "數據記錄與圖表", weight: 30 },
      { item: "結論與討論", weight: 35 },
      { item: "書寫清楚", weight: 10 },
    ],
  },
  {
    key: "science_observe",
    label: "觀察記錄",
    subject: "自然科學",
    instructions: "看學生有沒有真的觀察，記錄是否具體（時間、數量、變化），並嘗試說明看到的現象，不要只寫「很好玩」。",
    items: [
      { item: "觀察具體詳細", weight: 40 },
      { item: "現象說明合理", weight: 40 },
      { item: "記錄清楚", weight: 20 },
    ],
  },
  {
    key: "science_concept",
    label: "科學概念簡答",
    subject: "自然科學",
    instructions: "檢查科學概念是否正確，原因是否說明清楚，特別留意常見的迷思概念，並溫和指出正確的說法。",
    items: [
      { item: "概念正確", weight: 50 },
      { item: "原因說明完整", weight: 35 },
      { item: "用詞精確", weight: 15 },
    ],
  },
  {
    key: "history",
    label: "歷史事件分析",
    subject: "社會",
    instructions: "看學生是否說對事件的時間、人物與經過，能不能說明原因與影響，並用史料或課本內容當根據。",
    items: [
      { item: "事實正確", weight: 30 },
      { item: "原因與影響分析", weight: 45 },
      { item: "引用依據與表達", weight: 25 },
    ],
  },
  {
    key: "geography",
    label: "地理圖表判讀",
    subject: "社會",
    instructions: "檢查學生能不能從地圖或圖表讀出正確資訊，並用地理概念解釋現象（例如地形、氣候、人口）。",
    items: [
      { item: "圖表資訊讀取正確", weight: 40 },
      { item: "地理概念解釋", weight: 40 },
      { item: "文字表達", weight: 20 },
    ],
  },
  {
    key: "civics",
    label: "公民議題討論",
    subject: "社會",
    instructions: "看學生的立場是否清楚、理由是否合理並考慮不同觀點，不論立場為何，只評論理由的品質，不評論立場對錯。",
    items: [
      { item: "立場與理由清楚", weight: 40 },
      { item: "考慮不同觀點", weight: 35 },
      { item: "表達與用詞", weight: 25 },
    ],
  },
  {
    key: "art_appreciate",
    label: "美術作品賞析",
    subject: "藝術",
    instructions: "看學生能不能描述作品的顏色、構圖與線條，說出自己的感受和理由，尊重每個人不同的看法。",
    items: [
      { item: "觀察與描述具體", weight: 40 },
      { item: "感受與理由", weight: 40 },
      { item: "表達清楚", weight: 20 },
    ],
  },
  {
    key: "music_appreciate",
    label: "音樂欣賞心得",
    subject: "藝術",
    instructions: "看學生能不能聽出節奏、速度、樂器或情緒的變化，並說出自己的感受，不必有標準答案，重點是說得出理由。",
    items: [
      { item: "聽到什麼", weight: 40 },
      { item: "感受與理由", weight: 40 },
      { item: "表達清楚", weight: 20 },
    ],
  },
  {
    key: "art_creation",
    label: "創作說明",
    subject: "藝術",
    instructions: "看學生有沒有說明創作想法、用了什麼材料或技巧、過程中怎麼調整，鼓勵說出作品最想讓人看到的地方。",
    items: [
      { item: "創作想法", weight: 40 },
      { item: "材料與技巧說明", weight: 30 },
      { item: "自我檢討與調整", weight: 30 },
    ],
  },
  {
    key: "pe_log",
    label: "運動記錄與心得",
    subject: "健康與體育",
    instructions: "看記錄是否完整（項目、時間、次數或強度），感受與進步是否具體，鼓勵學生訂下一個小目標。",
    items: [
      { item: "記錄完整", weight: 40 },
      { item: "感受與進步", weight: 35 },
      { item: "下次目標", weight: 25 },
    ],
  },
  {
    key: "health_reflect",
    label: "健康行為反思",
    subject: "健康與體育",
    instructions: "看學生是否理解健康知識，並連結到自己的生活習慣，提出可行的改善做法，避免說教式的評語。",
    items: [
      { item: "健康知識正確", weight: 35 },
      { item: "連結自己的生活", weight: 35 },
      { item: "具體可行的做法", weight: 30 },
    ],
  },
  {
    key: "activity_reflect",
    label: "活動心得與反思",
    subject: "綜合活動",
    instructions: "看學生有沒有說出活動中做了什麼、和同學怎麼互動、學到什麼，並鼓勵具體的例子和真實的感受。",
    items: [
      { item: "活動經過具體", weight: 30 },
      { item: "人際互動與感受", weight: 35 },
      { item: "學到與收穫", weight: 35 },
    ],
  },
  {
    key: "career",
    label: "生涯探索",
    subject: "綜合活動",
    instructions: "看學生對自己興趣與能力的觀察是否具體，對職業或升學資料的整理是否有根據，並肯定任何真誠的想法。",
    items: [
      { item: "認識自己", weight: 40 },
      { item: "資料蒐集與整理", weight: 35 },
      { item: "下一步規劃", weight: 25 },
    ],
  },
  {
    key: "coding",
    label: "程式作品說明",
    subject: "科技與資訊",
    instructions: "看學生能不能說明程式要解決什麼問題、主要的邏輯（順序、判斷、迴圈）怎麼安排，以及測試時遇到什麼錯誤怎麼修。",
    items: [
      { item: "問題與目標清楚", weight: 25 },
      { item: "程式邏輯說明", weight: 40 },
      { item: "測試與除錯", weight: 35 },
    ],
  },
  {
    key: "digital_literacy",
    label: "資訊安全與數位素養心得",
    subject: "科技與資訊",
    instructions: "看學生是否理解密碼、個資、網路禮儀等概念，能不能舉出生活中的例子，並提出保護自己的具體做法。",
    items: [
      { item: "概念正確", weight: 40 },
      { item: "生活例子", weight: 30 },
      { item: "保護自己的做法", weight: 30 },
    ],
  },
  {
    key: "life_diary",
    label: "觀察日記",
    subject: "生活課程",
    instructions: "給低年級的短文，重點是有沒有寫出看到、聽到、做到的事，字句簡單就好，多用鼓勵的口氣，錯字只輕輕提醒一兩個。",
    items: [
      { item: "有觀察到具體的事", weight: 50 },
      { item: "有寫出自己的感覺", weight: 30 },
      { item: "句子完整", weight: 20 },
    ],
  },
  {
    key: "life_worksheet",
    label: "低年級學習單",
    subject: "生活課程",
    instructions: "低年級學生的學習單，答案大致正確就給分，評語簡短溫暖，只指出一個最重要的地方請他再想想。",
    items: [
      { item: "理解題目", weight: 50 },
      { item: "答案正確", weight: 30 },
      { item: "認真完成", weight: 20 },
    ],
  },
  {
    key: "mother_tongue",
    label: "本土語言短文",
    subject: "本土語文",
    instructions: "看學生是否用指定的本土語言（閩南語、客語或原住民族語）寫出意思完整的短文，可以用羅馬字或漢字，重點是敢寫、說得清楚，不要苛責拼寫。",
    items: [
      { item: "內容完整", weight: 40 },
      { item: "語言使用", weight: 40 },
      { item: "敢寫敢說", weight: 20 },
    ],
  },
];

/**
 * 依比例把總分分給各項：每項先保底 1 分，剩下的用最大餘數法照比例分，加總保證等於 total。
 * （舊寫法四捨五入後把差額補到最後一項，總分小的時候最後一項會變 0 分，例如 5 分的學習單變 3、2、0。
 *   後端 splitPointsFair 早就用這個做法，前端範本換算要跟它一樣。）
 * 總分比項目數還少時沒辦法每項都給 1 分，就照比例由前面的項目先拿。
 */
export function splitPoints(weights: number[], total: number): number[] {
  const n = weights.length;
  if (!n) return [];
  if (total < n) return weights.map((_, i) => (i < total ? 1 : 0));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const rest = total - n;
  const exact = weights.map((w) => (w / sum) * rest);
  const pts = exact.map((x) => 1 + Math.floor(x));
  let left = total - pts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, idx) => ({ idx, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) pts[order[k].idx] += 1;
  return pts;
}
