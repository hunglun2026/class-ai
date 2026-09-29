// 評分範本的資料檢查：npx tsx test/templates.test.mts
import { SUBJECTS, TEMPLATES, splitPoints } from "../src/templates.ts";
import { createRequire } from "node:module";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      → ${detail}` : ""}`);
};

const keys = TEMPLATES.map((t) => t.key);
check("key 不重複", new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i).join(","));
check("每個範本的科目都在科目清單裡", TEMPLATES.every((t) => (SUBJECTS as readonly string[]).includes(t.subject)),
  TEMPLATES.filter((t) => !(SUBJECTS as readonly string[]).includes(t.subject)).map((t) => t.key).join(","));
check("每個科目至少有一個範本", SUBJECTS.every((s) => TEMPLATES.some((t) => t.subject === s)),
  SUBJECTS.filter((s) => !TEMPLATES.some((t) => t.subject === s)).join(","));
check("每個範本配分比例加總 100", TEMPLATES.every((t) => t.items.reduce((a, i) => a + i.weight, 0) === 100),
  TEMPLATES.filter((t) => t.items.reduce((a, i) => a + i.weight, 0) !== 100).map((t) => t.key).join(","));
check("每個範本 2 到 4 個項目、每項比例大於 0", TEMPLATES.every((t) => t.items.length >= 2 && t.items.length <= 4 && t.items.every((i) => i.weight > 0)));
check("label 與 instructions 都不是空的", TEMPLATES.every((t) => t.label.trim() && t.instructions.trim().length >= 20));
check("同一科底下 label 不重複", TEMPLATES.every((t, i) => TEMPLATES.findIndex((u) => u.subject === t.subject && u.label === t.label) === i));

// 原本六個範本的 key 不能被改掉或拿掉
for (const k of ["essay", "reading", "worksheet", "math", "english", "project"]) {
  check(`舊範本 ${k} 還在`, keys.includes(k));
}

// 禁用詞（全域「用詞」規則）與破折號
const banned = ["賦能", "優化", "抓手", "顆粒度", "閉環", "增量", "語意", "渲染", "調性", "骨架", "症狀", "拷問", "落地", "對齊", "複盤", "打法", "心智模型", "認知負荷", "視覺化呈現", "痛點"];
const allText = TEMPLATES.map((t) => [t.label, t.instructions, ...t.items.map((i) => i.item)].join("\n")).join("\n");
check("沒有禁用詞", !banned.some((w) => allText.includes(w)), banned.filter((w) => allText.includes(w)).join(","));
check("沒有破折號", !/[—―]/.test(allText));

// 換算：各種總分加總都剛好等於總分，且每項至少 1 分
let sumsOk = true;
for (const t of TEMPLATES) for (const total of [4, 5, 10, 20, 100]) {
  const pts = splitPoints(t.items.map((i) => i.weight), total);
  if (pts.reduce((a, b) => a + b, 0) !== total || pts.some((p) => p < 1)) { sumsOk = false; console.log("      → 換算不對", t.key, total, pts.join(",")); }
}
check("各範本換成 4、5、10、20、100 分，加總都等於總分且每項至少 1 分", sumsOk);

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
