// 選擇題逐題比對的純函式測試：npx tsx test/choice-grade.test.mts
import { gradeChoiceAnswers } from "../src/lib/choice-grade.ts";
let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${!ok && d ? "\n      → " + d : ""}`); };

const key = "1.B 2.B 3.A 4.B 5.B 6.C 7.B 8.A 9.B 10.A 11.B 12.B 13.B 14.C 15.C 16.A 17.C 18.B 19.A 20.B\n每題 5 分，共 100 分。答案要和上面完全相同才給分，沒寫的算錯。";
// 2026-09-29 線上實測的真實學生作答：錯 4、9、12、17、20，漏 8，AI 當時給 45 分，正確應為 70
const stu = "1.B\n2.B\n3.A\n4.A\n5.B\n6.C\n7.B\n9.C\n10.A\n11.B\n12.A\n13.B\n14.C\n15.C\n16.A\n17.D\n18.B\n19.A\n20.C\n";
const r = gradeChoiceAnswers(key, stu, 100)!;
check("真實案例：14/20 對 = 70 分", r?.score === 70, JSON.stringify(r));
check("評語列出錯題與漏題", !!r && r.feedback.includes("第 4 題（你寫 A，正確是 B）") && r.feedback.includes("第 8 題") && r.feedback.includes("沒寫"), r?.feedback);
check("全對 = 滿分", gradeChoiceAnswers(key, key, 100)?.score === 100);
check("全錯 = 0 分", gradeChoiceAnswers("1.A 2.A 3.A", "1.B 2.B 3.B", 30)?.score === 0);
check("小數：3 題對 2 題、10 分 = 6.7", gradeChoiceAnswers("1.A 2.B 3.C", "1.A 2.B 3.D", 10)?.score === 6.7);
check("各種寫法：1) A／2：b／3 C／4、d／全形", gradeChoiceAnswers("1.A 2.B 3.C 4.D", "1) A\n2：b\n3 C\n４、Ｄ", 40)?.score === 40);
check("連寫 1A2B3C", gradeChoiceAnswers("1.A 2.B 3.C", "1A2B3C", 3)?.score === 3);
check("改答案以最後一次為準", gradeChoiceAnswers("1.A 2.B 3.C", "1.B 1.A 2.B 3.C", 3)?.score === 3);
check("題數不足 3 題的標準答案不啟用（交給 AI）", gradeChoiceAnswers("1.A 2.B", "1.A 2.B", 10) === null);
check("有長篇解說的標準答案不啟用", gradeChoiceAnswers("1.A 因為光沿直線前進所以影子和物體形狀相同，這是課本第三章重點，請同學務必背熟 2.B 3.C 4.D", "1.A 2.B 3.C 4.D", 10) === null);
check("學生作答讀不出題號（例如手寫照片轉字）交給 AI", gradeChoiceAnswers(key, "我覺得都是乙", 100) === null);
check("總分 0 或沒標準答案不啟用", gradeChoiceAnswers(key, stu, 0) === null && gradeChoiceAnswers("", stu, 100) === null);
check("沒寫題號、一串字母照順序對", gradeChoiceAnswers("1.B 2.A 3.C 4.D", "B A C C", 40)?.score === 30);
check("沒寫題號、一行一個字母", gradeChoiceAnswers("1.B 2.A 3.C", "B\nA\nC", 30)?.score === 30);
check("沒寫題號但數量對不上，退回 AI", gradeChoiceAnswers("1.B 2.A 3.C 4.D", "B A C", 40) === null);
check("沒寫題號又夾雜其他文字，退回 AI", gradeChoiceAnswers("1.B 2.A 3.C", "我選 B 然後 A 還有 C", 30) === null);
console.log(`\n${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
