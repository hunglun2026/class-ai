-- 十輪討論收斂出的P0：老師確認過的評分不能被「請AI重評」／「全部AI重評」悄悄蓋掉，
-- 且老師要看得出分數為什麼變了。用「鎖定旗標＋修改歷程」這個較輕量的做法達到同樣的
-- 安全保證，不做完整的多版本snapshot表（那個規模在MVP階段對單人開發過重）。

ALTER TABLE grades ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- 每次AI初評／AI重評／老師編輯／老師確認／老師解鎖都留一筆，供老師回顧「為什麼分數變了」
CREATE TABLE grade_history (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('AI_INITIAL', 'AI_REGRADE', 'TEACHER_EDIT', 'TEACHER_CONFIRM', 'TEACHER_REOPEN')),
  score REAL,
  feedback TEXT,
  changed_at INTEGER NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE INDEX idx_grade_history_submission ON grade_history(submission_id);
