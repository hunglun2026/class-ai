-- v1.19.0 評語風格：每位老師一套，套用在他所有的 AI 評分（含背景自動預批）。
-- 沒有這筆資料＝預設（三段式、溫暖鼓勵、中等長度），跟之前的評語一模一樣。
CREATE TABLE teacher_feedback_style (
  teacher_id TEXT PRIMARY KEY REFERENCES teachers(id),
  format TEXT NOT NULL DEFAULT 'three' CHECK (format IN ('three', 'two', 'one')),
  tone TEXT NOT NULL DEFAULT 'warm' CHECK (tone IN ('warm', 'concise', 'lively')),
  length TEXT NOT NULL DEFAULT 'medium' CHECK (length IN ('short', 'medium', 'long')),
  samples_json TEXT NOT NULL DEFAULT '[]',   -- 老師自己寫過的評語（最多 3 則），AI 模仿口吻
  updated_at INTEGER NOT NULL
);
