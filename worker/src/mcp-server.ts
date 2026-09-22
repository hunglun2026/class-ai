import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./types";
import { getValidAccessToken } from "./lib/tokens";
import { listCourses, listCourseWork } from "./lib/classroom";
import { listLowScoringStudents, getStudentScoreTrend, searchFeedback } from "./lib/mcp-queries";

// 唯讀第一階段：只給查詢工具，不做「觸發批次評分」這類寫入操作（見 進度.md 該次規劃的取捨）。
// 每個工具都用 teacherId（由 workers-oauth-provider 驗證 token 後帶進來，不是工具參數，
// 避免 MCP client 隨便填別人的 id 就能查到別人的資料）。
function buildServer(env: Env, teacherId: string): McpServer {
  const server = new McpServer({ name: "classai", version: "1.0.0" });

  server.registerTool(
    "list_courses",
    {
      title: "列出我的課程",
      description: "列出目前登入老師在 Google Classroom 的課程清單。",
      inputSchema: {},
    },
    async () => {
      const accessToken = await getValidAccessToken(env, teacherId);
      const courses = await listCourses(accessToken);
      return { content: [{ type: "text", text: JSON.stringify(courses) }] };
    }
  );

  server.registerTool(
    "list_coursework",
    {
      title: "列出某課程的作業",
      description: "列出指定課程底下的作業清單。",
      inputSchema: { courseId: z.string().describe("課程 ID，用 list_courses 取得") },
    },
    async ({ courseId }) => {
      const accessToken = await getValidAccessToken(env, teacherId);
      const work = await listCourseWork(accessToken, courseId);
      return { content: [{ type: "text", text: JSON.stringify(work) }] };
    }
  );

  server.registerTool(
    "low_scoring_students",
    {
      title: "找出低分學生（跨作業）",
      description:
        "依分數門檻，列出某課程裡目前分數低於此門檻的學生與對應作業，一次查完整門課，不用一份作業一份作業點開看。",
      inputSchema: {
        courseId: z.string(),
        threshold: z.number().default(60).describe("分數門檻，預設 60"),
      },
    },
    async ({ courseId, threshold }) => {
      const rows = await listLowScoringStudents(env, teacherId, courseId, threshold ?? 60);
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  server.registerTool(
    "student_score_trend",
    {
      title: "某位學生的成績趨勢",
      description: "列出某位學生在某課程裡，跨多次作業的分數與批改時間，依時間排序。",
      inputSchema: { courseId: z.string(), studentName: z.string().describe("學生姓名（跟 Classroom 顯示的名字一致）") },
    },
    async ({ courseId, studentName }) => {
      const rows = await getStudentScoreTrend(env, teacherId, courseId, studentName);
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  server.registerTool(
    "search_feedback",
    {
      title: "搜尋批改評語",
      description: "在某課程已批改的作業評語裡搜尋關鍵字，找出符合的學生與作業。",
      inputSchema: { courseId: z.string(), keyword: z.string() },
    },
    async ({ courseId, keyword }) => {
      const rows = await searchFeedback(env, teacherId, courseId, keyword);
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );

  return server;
}

// 無狀態模式：每個請求都是獨立的 McpServer + transport，Worker 本來就是每個請求各自處理，
// 不需要像長駐 process 那樣維護連線狀態，也因此不需要 Durable Objects。
export async function handleMcpRequest(request: Request, env: Env, teacherId: string): Promise<Response> {
  const server = buildServer(env, teacherId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}
