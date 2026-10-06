-- v1.22.0 一鍵發還：分數寫成正式分數並發還給學生，評語放在 classAI 的評語頁（學生用連結看）。
-- 開新表不改 grade_pushes：理由同 0016（舊測試有不寫欄位名的 INSERT）。
CREATE TABLE grade_returns (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  feedback_token TEXT NOT NULL UNIQUE,   -- 評語頁網址裡的隨機碼（128 位元），學生不用登入就能看，猜不到
  returned_score REAL,                   -- 發還當下的分數與評語（評語頁顯示的是這份，老師之後改了要再發還）
  returned_feedback TEXT,
  link_attached INTEGER NOT NULL DEFAULT 0, -- 評語連結有沒有成功加到學生的繳交上
  returned_at INTEGER,
  returned_by TEXT REFERENCES teachers(id)
);
