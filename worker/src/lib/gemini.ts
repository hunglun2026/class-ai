import type { AiGradeResult, Rubric } from "../types";
import type { ExtractedAttachment } from "./drive";

// 三層容錯：依序試到成功為止。用 `-latest` 別名（跟 school/el 正式環境同寫法），
// Google 換版時不會因為寫死版號而整支壞掉。
// 2026-09-14 實測：這把 API key 的 pro 額度（免費層）很容易打光（429），
// flash 偶爾短暫過載（503），flash-lite 最穩定又能正確輸出JSON，改成優先用它，
// pro 留最後一層，額度恢復時還是能用到更強的模型。
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-pro-latest"];

function buildRubricInstruction(rubric: Rubric): string {
  if (rubric.mode === "freetext") {
    return `評分指令（老師手寫）：\n${rubric.instructions ?? ""}\n總分 ${rubric.maxPoints} 分。`;
  }
  if (rubric.mode === "rubric") {
    const items = rubric.rubricJson ?? [];
    const lines = items.map((it) => `- ${it.item}（滿分 ${it.maxPoints}）：${it.description ?? ""}`).join("\n");
    return `評分量表（逐項給分，各項加總＝總分）：\n${lines}\n總分 ${rubric.maxPoints} 分。`;
  }
  const fileNote = rubric.answerKeyFile ? `\n另外老師上傳了標準答案檔案（見附件「${rubric.answerKeyFile.name}」，請一併參考）。` : "";
  return `標準答案：\n${rubric.answerKey ?? "（見附件）"}${fileNote}\n請比對學生作答與標準答案的吻合程度給分，總分 ${rubric.maxPoints} 分。`;
}

function buildPrompt(rubric: Rubric, studentText: string): string {
  const rubricText = buildRubricInstruction(rubric);
  const itemSchemaHint =
    rubric.mode === "rubric"
      ? `\n"itemScores": [{"item": "評分項目名稱", "score": 數字, "comment": "這項給幾分的理由"}],`
      : "";

  return `你是台灣中小學老師的教學助理，負責初步批改學生作業，最終分數由老師確認，你的評分只是建議值。

${rubricText}

學生作答內容（可能包含文字、隨附圖片/PDF）如下：
"""
${studentText || "（學生沒有直接輸入文字，內容請參考附件）"}
"""

請用台灣的教學用語（不要大陸用語、不要 AI 腔），只回傳以下格式的 JSON，不要 markdown 圍欄、不要任何說明文字：
{
  "score": 數字（0～${rubric.maxPoints}）,${itemSchemaHint}
  "feedback": "給學生看的評語，固定三段、每段一到兩句，段落之間換行：\\n【做得好】具體指出一個優點\\n【可以更好】具體指出最需要改的一點\\n【下一步】一個學生馬上做得到的動作"
}
評語是寫給學生本人看的：用學生年紀看得懂的白話，不用專業術語，不要用 emoji。`;
}

// 失敗原因分類：路由層拿這個換成老師看得懂的話，模型原始錯誤只進 log，不回傳前端
export type GradeFailKind = "quota" | "timeout" | "blocked" | "bad_output" | "unknown";

export class GradeError extends Error {
  constructor(public kind: GradeFailKind, detail: string) {
    super(detail);
  }
}

function classify(msg: string): GradeFailKind {
  if (/ 429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return "quota";
  if (/沒有回應|timeout| 503| 504/i.test(msg)) return "timeout";
  if (/安全過濾|SAFETY|blocked/i.test(msg)) return "blocked";
  if (/JSON|Unexpected token/i.test(msg)) return "bad_output";
  return "unknown";
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

function pushAttachmentParts(parts: GeminiPart[], attachments: ExtractedAttachment[], label: string) {
  for (const att of attachments) {
    if (att.kind === "text" && att.text) {
      parts.push({ text: `\n${label}「${att.name}」內文：\n${att.text}` });
    } else if ((att.kind === "image" || att.kind === "pdf") && att.base64 && att.mimeType) {
      parts.push({ text: `\n以下是${label}「${att.name}」：` });
      parts.push({ inline_data: { mime_type: att.mimeType, data: att.base64 } });
    }
  }
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  attachments: ExtractedAttachment[],
  answerKeyAttachment: ExtractedAttachment | null,
  maxPoints: number
): Promise<AiGradeResult> {
  const parts: GeminiPart[] = [{ text: prompt }];
  // 標準答案附件跟學生作答附件分開標註，避免 AI 把老師的答案當成學生自己交的內容
  if (answerKeyAttachment) pushAttachmentParts(parts, [answerKeyAttachment], "老師提供的標準答案附件");
  pushAttachmentParts(parts, attachments, "學生作答附件");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  // 沒設 timeout 的話，一次卡住的請求會拖住整個三層容錯（等到 Cloudflare 自己的邊界逾時才放棄），
  // 30 秒還沒回應就直接判失敗、換下一個模型
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new Error(`${model} 30 秒內沒有回應`);
    throw e;
  }
  if (!res.ok) throw new Error(`${model} 回 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const data = await res.json<any>();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`${model} 沒有回傳內容（可能被安全過濾擋下或額度用盡）`);
  const parsed = JSON.parse(text) as AiGradeResult;
  // 模型偶爾會把分數寫成字串、或給超出上限的值——夾回 0～maxPoints，老師看到的建議值才不會怪
  const raw = Number(parsed.score);
  parsed.score = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), maxPoints) : 0;
  return parsed;
}

export async function gradeSubmission(
  apiKey: string,
  rubric: Rubric,
  studentText: string,
  attachments: ExtractedAttachment[]
): Promise<{ result: AiGradeResult; model: string }> {
  const prompt = buildPrompt(rubric, studentText);
  const answerKeyAttachment: ExtractedAttachment | null = rubric.answerKeyFile
    ? rubric.answerKeyFile.extractedText
      ? { name: rubric.answerKeyFile.name, kind: "text", text: rubric.answerKeyFile.extractedText }
      : {
          name: rubric.answerKeyFile.name,
          kind: rubric.answerKeyFile.mimeType === "application/pdf" ? "pdf" : "image",
          base64: rubric.answerKeyFile.base64,
          mimeType: rubric.answerKeyFile.mimeType,
        }
    : null;
  const errors: string[] = [];
  for (const model of MODELS) {
    try {
      const result = await callGemini(apiKey, model, prompt, attachments, answerKeyAttachment, rubric.maxPoints);
      return { result, model };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  // 三層都失敗時，只要有任一層是額度問題就算額度（最常見、老師最該知道的原因）
  const kinds = errors.map(classify);
  const kind = kinds.includes("quota") ? "quota" : kinds[kinds.length - 1] ?? "unknown";
  throw new GradeError(kind, `所有模型都評分失敗：${errors.join(" | ")}`);
}
