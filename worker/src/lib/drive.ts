import { extractDocxText } from "./docx";
import { bytesToBase64 } from "./base64";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * 把學生繳交附件轉成 AI 看得懂的內容：
 * - Google Docs/Slides → export 成純文字
 * - Word (.docx) → 下載原始位元組，解析成純文字（Gemini讀不懂docx二進位格式）
 * - 圖片/PDF → 下載成 base64，交給 Gemini 多模態直接讀
 *
 * 大小上限：Worker 只有 128MB 記憶體，檔案原始位元組、base64 字串、送 Gemini 的 JSON 本體會同時存在，
 * 大約吃掉原始大小的 4 倍。單檔超過上限、或超過呼叫端給的剩餘額度（一次評分所有檔案合計），
 * 就不下載，回 kind:"too_large" 讓呼叫端告訴老師「這個檔案 AI 沒讀到」。
 */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export interface ExtractedAttachment {
  name: string;
  kind: "text" | "image" | "pdf" | "unsupported" | "too_large";
  text?: string;
  base64?: string;
  mimeType?: string;
  // 實際下載的原始位元組數，呼叫端用來扣總量額度（Google 原生文件 export 的純文字不算）
  bytes?: number;
}

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export async function extractDriveFile(
  accessToken: string,
  fileId: string,
  fallbackName: string,
  remainingBytes: number
): Promise<ExtractedAttachment> {
  const limit = Math.min(MAX_ATTACHMENT_BYTES, remainingBytes);
  const metaRes = await fetch(`${DRIVE_BASE}/files/${fileId}?fields=id,name,mimeType,size`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) {
    return { name: fallbackName, kind: "unsupported" };
  }
  const meta = await metaRes.json<{ name: string; mimeType: string; size?: string }>();
  // size 只有上傳的二進位檔才有（Google 原生文件沒有），有就先擋，不用真的下載才知道太大
  const declaredSize = meta.size ? Number(meta.size) : 0;

  // Google 原生文件（Docs/Slides）沒有二進位內容，要用 export
  if (meta.mimeType === "application/vnd.google-apps.document" || meta.mimeType === "application/vnd.google-apps.presentation") {
    const exportRes = await fetch(`${DRIVE_BASE}/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!exportRes.ok) return { name: meta.name, kind: "unsupported" };
    return { name: meta.name, kind: "text", text: await exportRes.text() };
  }

  // docx 最後只送解析出的純文字，不佔 Gemini 附件額度，只擋單檔上限（下載當下的記憶體）
  if (meta.mimeType === DOCX_MIME) {
    if (declaredSize > MAX_ATTACHMENT_BYTES) return { name: meta.name, kind: "too_large" };
    const fileRes = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) return { name: meta.name, kind: "unsupported" };
    const buf = await fileRes.arrayBuffer();
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) return { name: meta.name, kind: "too_large" };
    try {
      const text = extractDocxText(new Uint8Array(buf));
      return { name: meta.name, kind: "text", text };
    } catch (e) {
      console.error("[drive] docx解析失敗", meta.name, e);
      return { name: meta.name, kind: "unsupported" };
    }
  }

  const isImage = meta.mimeType.startsWith("image/");
  const isPdf = meta.mimeType === "application/pdf";
  if (!isImage && !isPdf) {
    return { name: meta.name, kind: "unsupported" };
  }
  if (declaredSize > limit) return { name: meta.name, kind: "too_large" };

  const fileRes = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) return { name: meta.name, kind: "unsupported" };
  const buf = await fileRes.arrayBuffer();
  // 沒回 size 的少見情況，下載完再擋一次
  if (buf.byteLength > limit) return { name: meta.name, kind: "too_large" };

  return { name: meta.name, kind: isPdf ? "pdf" : "image", base64: bytesToBase64(buf), mimeType: meta.mimeType, bytes: buf.byteLength };
}
