-- 老師（Google 帳號）
CREATE TABLE teachers (
  id TEXT PRIMARY KEY,               -- Google sub
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  refresh_token TEXT NOT NULL,       -- Classroom API 用，加密存放（見 lib/crypto.ts）
  access_token TEXT,
  access_token_expires_at INTEGER,   -- unix seconds
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 課程（快取 Classroom courses，避免每次都打 API）
CREATE TABLE courses (
  id TEXT PRIMARY KEY,               -- classroom courseId
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  name TEXT NOT NULL,
  section TEXT,
  synced_at INTEGER NOT NULL
);

-- 作業（快取 Classroom courseWork）
CREATE TABLE coursework (
  id TEXT PRIMARY KEY,               -- classroom courseWorkId
  course_id TEXT NOT NULL REFERENCES courses(id),
  title TEXT NOT NULL,
  description TEXT,
  max_points REAL,
  synced_at INTEGER NOT NULL
);

-- 評分規則（老師針對某個作業設定的評分標準，三種模式並存）
CREATE TABLE rubrics (
  id TEXT PRIMARY KEY,
  coursework_id TEXT NOT NULL REFERENCES coursework(id),
  mode TEXT NOT NULL CHECK (mode IN ('freetext', 'rubric', 'answer_key')),
  instructions TEXT,                 -- freetext 模式：自由文字評分指令
  rubric_json TEXT,                  -- rubric 模式：[{item, maxPoints, description}]
  answer_key TEXT,                   -- answer_key 模式：標準答案文字
  max_points REAL NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 學生繳交內容（快取 Classroom studentSubmissions + 抓下來的文字/附件）
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,               -- classroom submissionId
  coursework_id TEXT NOT NULL REFERENCES coursework(id),
  student_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  state TEXT NOT NULL,               -- TURNED_IN / RETURNED / ...
  content_text TEXT,                 -- 抽出來的純文字（Doc 內文、或學生直接打字的短答）
  attachments_json TEXT,             -- [{type: 'doc'|'image'|'pdf'|'link', driveFileId, name, mimeType}]
  fetched_at INTEGER NOT NULL
);

-- AI 評分結果 + 老師的最終定案
CREATE TABLE grades (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  rubric_id TEXT REFERENCES rubrics(id),
  ai_score REAL,
  ai_feedback TEXT,
  ai_raw_json TEXT,                  -- 完整 AI 回傳（含逐項給分，供除錯與量表模式顯示）
  ai_model TEXT,                     -- 實際用了哪個模型（雙模型容錯後的結果）
  final_score REAL,                  -- 老師確認/修改後的分數（未改就等於 ai_score）
  final_feedback TEXT,
  status TEXT NOT NULL DEFAULT 'ai_suggested' CHECK (status IN ('ai_suggested', 'teacher_edited', 'confirmed')),
  graded_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (submission_id)
);

CREATE INDEX idx_courses_teacher ON courses(teacher_id);
CREATE INDEX idx_coursework_course ON coursework(course_id);
CREATE INDEX idx_rubrics_coursework ON rubrics(coursework_id);
CREATE INDEX idx_submissions_coursework ON submissions(coursework_id);
CREATE INDEX idx_grades_submission ON grades(submission_id);
