-- v1.21.0 常用評語庫：老師自己存的短句，批改時點一下插進評語。每位老師最多 30 句（路由端檢查）。
CREATE TABLE teacher_phrases (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_teacher_phrases_teacher ON teacher_phrases(teacher_id, created_at);
