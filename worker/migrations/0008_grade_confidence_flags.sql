-- 簡版可信度提示：AI評分後端算出的heuristic警示（缺評分項目／極端分數），JSON字串陣列，沒有警示就是NULL
ALTER TABLE grades ADD COLUMN confidence_flags TEXT;
