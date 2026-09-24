-- v1.17.0 背景自動預批改：老師打開時批改已經在等，不用守著畫面等 AI 一位一位評。
-- 老師「存評分標準」或「打開批改頁」就登記接手 21 天，Cron 每 10 分鐘用這位老師的授權
-- 去 Classroom 拉新繳交、叫 AI 評。沒設評分標準的作業不碰。
CREATE TABLE autograde_watch (
  coursework_id TEXT PRIMARY KEY REFERENCES coursework(id),
  course_id TEXT NOT NULL REFERENCES courses(id),
  teacher_id TEXT NOT NULL REFERENCES teachers(id),  -- 用誰的 Google 授權去拉
  watch_until INTEGER NOT NULL,                       -- unix 秒，過了就不再輪詢
  last_synced_at INTEGER,
  last_error TEXT                                     -- 例：auth_expired（老師要重新登入）
);
CREATE INDEX idx_autograde_watch_until ON autograde_watch(watch_until);

-- AI 沒辦法評的原因（讀不到附件、只交連結、被安全機制擋、連續失敗 3 次），給老師看「需要你自己批」。
-- 針對的是哪一版繳交（turned_in_at），學生重交就重置，重新給 AI 試。
ALTER TABLE submissions ADD COLUMN autograde_error TEXT;
ALTER TABLE submissions ADD COLUMN autograde_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN autograde_for_turned_in_at INTEGER;
