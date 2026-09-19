-- 老師自己存的常用評分標準範本，跨作業套用（不是worker/src/routes/rubrics.ts那個單一作業
-- 的評分標準，是老師個人的範本庫）。刻意不存answer_key的檔案附件（base64/extracted_text）：
-- 十輪討論裡這是範本庫最大的架構風險（base64存進範本會讓資料庫暴增、讀清單被迫載入巨型
-- 檔案），MVP先只存文字內容，檔案附件留到之後真的需要再做。
CREATE TABLE rubric_templates (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('freetext', 'rubric', 'answer_key')),
  instructions TEXT,
  rubric_json TEXT,
  answer_key TEXT,
  max_points REAL NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_rubric_templates_teacher ON rubric_templates(teacher_id);
