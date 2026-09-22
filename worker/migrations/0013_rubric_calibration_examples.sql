-- 跟 grading_calibration_logs（migration 0005，匿名聚合統計用）不同：這張表存內容片段，
-- 但只限同一份評分標準（同一位老師）自己重複使用，評分時當校準範例餵回 AI，不做跨老師共用語料庫。
CREATE TABLE rubric_calibration_examples (
  id TEXT PRIMARY KEY,
  rubric_id TEXT NOT NULL REFERENCES rubrics(id),
  student_excerpt TEXT NOT NULL,       -- content_text 截斷到安全長度
  ai_score REAL NOT NULL,
  ai_feedback TEXT,
  teacher_final_score REAL NOT NULL,
  teacher_final_feedback TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_rubric_calibration_rubric ON rubric_calibration_examples(rubric_id);
