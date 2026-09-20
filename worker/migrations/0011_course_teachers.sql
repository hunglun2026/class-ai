-- 一門課可以有多位老師（導師＋科任、實習老師、代課）。以前 courses 只記一個 teacher_id，
-- 第二位老師點進去每一步都會被判定「不是你的課」，等於不能用。
-- 權限改查這張表；courses.teacher_id 保留當「第一個同步的人」的紀錄，不再拿來判斷。
CREATE TABLE course_teachers (
  course_id TEXT NOT NULL REFERENCES courses(id),
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (course_id, teacher_id)
);
CREATE INDEX idx_course_teachers_teacher ON course_teachers(teacher_id);

-- 既有課程的老師搬進來，舊資料不會因為改判斷方式而突然不能用
INSERT INTO course_teachers (course_id, teacher_id, added_at)
  SELECT id, teacher_id, synced_at FROM courses;
