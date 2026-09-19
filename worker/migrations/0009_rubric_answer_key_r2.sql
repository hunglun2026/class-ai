-- 標準答案檔（圖片/PDF）改存 R2，D1 只記物件位置。
-- D1 單列上限 2MB（任何方案都不能調高），base64 放大 4/3 倍後，原始檔超過約 1.4MB 就存不進去。
-- 舊資料的 answer_key_file_base64 保留不搬，讀取時 r2_key 沒值就退回讀 base64。
ALTER TABLE rubrics ADD COLUMN answer_key_file_r2_key TEXT;
