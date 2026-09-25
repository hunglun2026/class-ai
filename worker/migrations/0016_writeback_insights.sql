-- v1.18.0 在 classAI 出作業 → 老師確認的分數送回 Classroom 草稿分數；全班學習診斷。
-- 都開新表不在舊表加欄位：舊表的測試與程式有不寫欄位名的 INSERT，加欄位會讓那些寫法壞掉。

-- 老師有沒有給「可寫入 Classroom 作業」的權限（漸進式授權，老師第一次在 classAI 出作業時才要）
CREATE TABLE teacher_write_access (
  teacher_id TEXT PRIMARY KEY REFERENCES teachers(id),
  can_write INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 這份作業能不能寫分數回 Classroom：Google 只讓建立作業的同一個 API 專案寫，
-- 值直接取自 Classroom API 的 associatedWithDeveloper，不自己猜
CREATE TABLE coursework_writeback (
  coursework_id TEXT PRIMARY KEY REFERENCES coursework(id),
  can_write_back INTEGER NOT NULL DEFAULT 0,
  created_by_classai_at INTEGER,          -- 在 classAI 出的作業才有
  updated_at INTEGER NOT NULL
);

-- 送到 Classroom 的草稿分數紀錄：送了之後老師又改分，要提醒「Classroom 上是舊分數」
CREATE TABLE grade_pushes (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  pushed_score REAL NOT NULL,
  pushed_at INTEGER NOT NULL,
  pushed_by TEXT NOT NULL REFERENCES teachers(id)
);

-- 全班學習診斷的快取：fingerprint 是全班分數與評語的摘要，有變才需要重算
CREATE TABLE class_insights (
  coursework_id TEXT PRIMARY KEY REFERENCES coursework(id),
  fingerprint TEXT NOT NULL,
  graded_count INTEGER NOT NULL,
  insights_json TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL
);
