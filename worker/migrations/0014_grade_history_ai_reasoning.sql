-- 2026-09-23 這輪10輪討論收斂出的P0：AI建議分數旁邊要有「為什麼」跟「這次評分可不可信」，
-- 老師被家長/學生問起時才有紀錄可以說明，也是三色分流(risk_signal)的資料來源。
-- 沿用grade_history既有表（不拆新表，MVP階段先用JSONB快照），只在AI_INITIAL/AI_REGRADE
-- 這兩種source才會寫入這兩欄，老師改分/確認那幾種source維持NULL。
-- 這兩欄視為「當時AI怎麼判斷的」不可變快照，老師後續改分不會回頭改寫這裡的內容。
ALTER TABLE grade_history ADD COLUMN ai_reasoning TEXT;
ALTER TABLE grade_history ADD COLUMN risk_signal TEXT;

-- 三色分流(🟢🟡🔴)存在grades（目前狀態，列表頁直接查得到，不用每次去翻grade_history找最新一筆）。
-- 沿用confidence.ts既有的heuristic規則精神：不额外多打AI（不重評3次，避免3倍AI成本，
-- 這點上一輪十輪討論已經否決過"讓AI自評信心"這條路），risk_level是後端用confidenceFlags
-- ＋分數位置＋有沒有校準範例這些「已經算好的證據」組合出來的。
ALTER TABLE grades ADD COLUMN risk_level TEXT CHECK (risk_level IN ('green', 'yellow', 'red'));
