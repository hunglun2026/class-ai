import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables } from "./types";
import { authRoutes } from "./routes/auth";
import { courseRoutes } from "./routes/courses";
import { rubricRoutes } from "./routes/rubrics";
import { submissionRoutes } from "./routes/submissions";
import { calibrationRoutes } from "./routes/calibration";
import { rubricTemplateRoutes } from "./routes/rubricTemplates";
import { GoogleAuthExpiredError } from "./lib/google-oauth";
import { ZodError } from "zod";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  // exposeHeaders：成績表下載走 fetch 讀 Blob，前端要讀得到這裡算好的檔名
  const cors_ = cors({ origin: c.env.APP_URL, credentials: true, exposeHeaders: ["Content-Disposition"] });
  return cors_(c, next);
});

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, version: c.env.APP_VERSION }));

app.route("/api/auth", authRoutes);
app.route("/api/courses", courseRoutes);
app.route("/api/rubrics", rubricRoutes);
app.route("/api/submissions", submissionRoutes);
app.route("/api/calibration", calibrationRoutes);
app.route("/api/rubric-templates", rubricTemplateRoutes);

app.onError((err, c) => {
  // 前端送來的資料格式不對（zod 驗證沒過）是請求的問題不是系統壞了，回 400；細節只進 log
  if (err instanceof ZodError) {
    console.warn(`[BAD_REQUEST] ${c.req.method} ${c.req.url}:`, JSON.stringify(err.issues).slice(0, 500));
    return c.json({ error: "送出的資料格式不對，請重新整理頁面再試一次" }, 400);
  }
  console.error(`[CRITICAL_ERROR] ${c.req.method} ${c.req.url}:`, err);
  // Google 授權過期不是「系統壞了」，是老師要重新登入——回具體訊息＋401，
  // 不要跟其他真正的系統錯誤混在一起變成看不懂的「系統暫時發生問題」
  if (err instanceof GoogleAuthExpiredError) {
    return c.json({ error: err.message, code: "auth_expired" }, 401);
  }
  return c.json({ error: "系統暫時發生問題，請稍後再試" }, 500);
});

export default app;
