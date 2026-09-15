-- Excel 答案檔在後端解析成文字表格後存這裡（AI 讀不懂 Excel 二進位格式，要先轉文字）
ALTER TABLE rubrics ADD COLUMN answer_key_file_extracted_text TEXT;
