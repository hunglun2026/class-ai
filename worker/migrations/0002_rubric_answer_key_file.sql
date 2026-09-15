-- 標準答案比對模式支援上傳圖片/PDF 當答案檔（取代/補充純文字貼上）
ALTER TABLE rubrics ADD COLUMN answer_key_file_name TEXT;
ALTER TABLE rubrics ADD COLUMN answer_key_file_mime TEXT;
ALTER TABLE rubrics ADD COLUMN answer_key_file_base64 TEXT;
