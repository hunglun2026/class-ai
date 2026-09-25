// 同學作答雷同提醒的純函式測試：npx tsx test/similarity.test.mts
import { findSimilar } from "../src/similarity.ts";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      → ${detail}` : ""}`);
};

const essay = "四季的形成是因為地球的自轉軸傾斜大約二十三點五度，地球繞著太陽公轉的時候，太陽直射的位置會在南北回歸線之間移動。夏天太陽比較直射，白天比較長，所以比較熱；冬天太陽斜射，白天比較短，所以比較冷。這跟地球離太陽的遠近沒有什麼關係。";
const copied = essay;
const tweaked = essay.replace("大約", "差不多").replace("所以比較熱", "因此比較熱").replace("什麼", "太大");
const different = "我覺得四季很有趣。春天花會開，夏天可以去海邊玩水，秋天葉子會變黃掉下來，冬天很冷要穿外套。老師上課說四季跟地球有關係，地球會轉來轉去，所以天氣會變。我最喜歡的是夏天，因為放暑假可以一直玩，也可以吃很多冰淇淋，真的很開心。";
const reordered = essay.split("；").reverse().join("；");

const r = findSimilar([
  { id: "a", student_name: "甲", content_text: essay },
  { id: "b", student_name: "乙", content_text: copied },
  { id: "c", student_name: "丙", content_text: tweaked },
  { id: "d", student_name: "丁", content_text: different },
  { id: "e", student_name: "戊", content_text: "答案是 C" },
  { id: "f", student_name: "己", content_text: "答案是 C" },
  { id: "g", student_name: "庚", content_text: null },
]);
check("一字不差：100%", r.get("b")?.percent === 100, JSON.stringify(r.get("b")));
check("改幾個詞：還是抓得到（≥80%）", (r.get("c")?.percent ?? 0) >= 80, JSON.stringify(r.get("c")));
check("同題目、自己寫的：不標", !r.has("d"), JSON.stringify(r.get("d")));
check("太短的答案（一樣也不比）：不標", !r.has("e") && !r.has("f"));
check("沒有文字：不標、不當掉", !r.has("g"));
const r2 = findSimilar([
  { id: "a", student_name: "甲", content_text: essay },
  { id: "h", student_name: "辛", content_text: reordered },
]);
check("句子調換順序：抓得到", (r2.get("h")?.percent ?? 0) >= 80, JSON.stringify(r2.get("h")));
check("標點空白不同不影響", findSimilar([
  { id: "a", student_name: "甲", content_text: essay },
  { id: "i", student_name: "壬", content_text: essay.replace(/，/g, ", ").replace(/。/g, ".\n") },
]).get("i")?.percent === 100);

// 效能：40 位、每位 1500 字，全部兩兩比
const big = Array.from({ length: 40 }, (_, i) => ({
  id: `s${i}`, student_name: `學生${i}`,
  content_text: Array.from({ length: 1500 }, (_, k) => String.fromCharCode(0x4e00 + ((i * 7919 + k * 104729) % 20000))).join(""),
}));
const t0 = performance.now();
findSimilar(big);
const ms = performance.now() - t0;
check(`40 位 × 1500 字全部比對在 300ms 內（實際 ${ms.toFixed(0)}ms）`, ms < 300);

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
