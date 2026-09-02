# 作業 AI 評分（class-ai）

老師登入 Google → 選 Classroom 課程/作業 → 拉學生繳交內容（文字/圖片/PDF）→
Gemini 給建議分數與評語 → 老師在工具內直接看/改。

- `worker/`：Cloudflare Worker（Hono + D1 + KV + R2）後端
- `web/`：React + Vite 前端（Cloudflare Pages 自動部署，根目錄 `web/`）

原始碼的家在私有 monorepo，這個 repo 只負責「push 就自動部署」。
