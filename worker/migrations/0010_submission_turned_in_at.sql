-- 學生最後一次繳交的時間（unix 秒，取自 Classroom submissionHistory 最後一筆 TURNED_IN）。
-- 比評分時間（grades.updated_at）晚＝學生在老師評分後又重交，批改頁要提醒老師這個分數是舊版本的。
ALTER TABLE submissions ADD COLUMN turned_in_at INTEGER;
