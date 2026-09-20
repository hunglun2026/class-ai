-- 每位老師每天用了幾次 AI 評分。所有老師共用同一把 Gemini 金鑰，沒有上限的話一位老師連點
-- 就可能把當天額度吃光，其他老師全部評不了；按學校收費也需要這份紀錄。
-- day 用台灣時間的 YYYY-MM-DD：老師的「一天」是台灣時間，用 UTC 會在晚上 8 點就重置。
CREATE TABLE ai_usage (
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (teacher_id, day)
);
