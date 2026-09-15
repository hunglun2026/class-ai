-- rubrics 原本是「取代式儲存」，每次存都INSERT新一列，舊版本永遠留著不會被清掉，
-- 時間久了會一直長。改成一份作業只有一列，用UNIQUE + ON CONFLICT真正做覆蓋式更新。
-- （查過production目前每個coursework_id最多只有一列，不用先清重複資料。）
CREATE UNIQUE INDEX idx_rubrics_coursework_id ON rubrics(coursework_id);
