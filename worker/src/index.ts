import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables } from "./types";
import { authRoutes } from "./routes/auth";
import { courseRoutes } from "./routes/courses";
import { rubricRoutes } from "./routes/rubrics";
import { submissionRoutes } from "./routes/submissions";
import { calibrationRoutes } from "./routes/calibration";
import { rubricTemplateRoutes } from "./routes/rubricTemplates";
import { usageRoutes } from "./routes/usage";
import { GoogleAuthExpiredError } from "./lib/google-oauth";
import { ZodError } from "zod";
import { ClassroomError } from "./lib/classroom";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  // exposeHeaders：成績表下載走 fetch 讀 Blob，前端要讀得到這裡算好的檔名
  const cors_ = cors({ origin: c.env.APP_URL, credentials: true, exposeHeaders: ["Content-Disposition"] });
  return cors_(c, next);
});

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT, version: c.env.APP_VERSION }));

// 會改資料的請求（POST/PATCH/DELETE）只接受從自家網站送出的：擋掉別的網站趁老師登入中
// 偷用他的身分送請求（CSRF）。瀏覽器一定會帶 Origin，帶錯就是別的網站；
// 本機開發（localhost）與沒有 Origin 的伺服器對伺服器呼叫（例如測試）放行。
app.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const origin = c.req.header("Origin");
  if (!origin) return next();
  const allowed = origin === c.env.APP_URL || /^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
  if (!allowed) {
    console.warn(`[BAD_ORIGIN] ${c.req.method} ${c.req.url} from ${origin}`);
    return c.json({ error: "這個請求不是從 classAI 網站送出的，已經擋下來" }, 403);
  }
  return next();
});

app.route("/api/auth", authRoutes);
app.route("/api/courses", courseRoutes);
app.route("/api/rubrics", rubricRoutes);
app.route("/api/submissions", submissionRoutes);
app.route("/api/calibration", calibrationRoutes);
app.route("/api/rubric-templates", rubricTemplateRoutes);
app.route("/api/usage", usageRoutes);

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
  // Classroom 拒絕或找不到：講出最可能的原因和該怎麼做，不要只說「系統暫時發生問題」
  if (err instanceof ClassroomError) {
    if (err.status === 401) {
      return c.json({ error: "Google 授權已過期或被取消，請重新登入", code: "auth_expired" }, 401);
    }
    if (err.status === 403) {
      return c.json(
        {
          error: "Google Classroom 拒絕讓 classAI 讀取。可能是學校的 Google 管理員還沒開放外部 App 使用 Classroom，請聯絡學校資訊組；如果是個人帳號，請登出後重新登入並勾選全部權限",
          code: "classroom_forbidden",
        },
        403
      );
    }
    if (err.status === 404) {
      return c.json({ error: "Classroom 找不到這門課或這份作業，可能已經被刪除或封存，請回上一步重新選", code: "classroom_not_found" }, 404);
    }
    if (err.status === 429) {
      return c.json({ error: "Google Classroom 暫時忙不過來，請過一分鐘再試", code: "classroom_busy" }, 429);
    }
  }
  return c.json({ error: "系統暫時發生問題，請稍後再試" }, 500);
});

export default app;
