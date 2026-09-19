-- 累積「AI評分 vs 老師最終定案」的校正資料，用來衡量AI評分可信度（老師修改比例）。
-- 刻意不存學生姓名/作業原文/老師身分——只存分數與作業性質，供聚合統計，不可回溯到任何人。
CREATE TABLE grading_calibration_logs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('freetext', 'rubric', 'answer_key')),
  max_points REAL NOT NULL,
  ai_score REAL NOT NULL,
  teacher_final_score REAL NOT NULL,
  score_diff REAL GENERATED ALWAYS AS (ABS(ai_score - teacher_final_score)) VIRTUAL,
  created_at INTEGER NOT NULL
);
