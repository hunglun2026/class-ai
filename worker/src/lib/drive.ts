import { extractDocxText } from "./docx";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * 把學生繳交附件轉成 AI 看得懂的內容：
 * - Google Docs/Slides → export 成純文字
 * - Word (.docx) → 下載原始位元組，解析成純文字（Gemini讀不懂docx二進位格式）
 * - 圖片/PDF → 下載成 base64，交給 Gemini 多模態直接讀
 */

export interface ExtractedAttachment {
  name: string;
  kind: "text" | "image" | "pdf" | "unsupported";
  text?: string;
  base64?: string;
  mimeType?: string;
}

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

export async function extractDriveFile(accessToken: string, fileId: string, fallbackName: string): Promise<ExtractedAttachment> {
  const metaRes = await fetch(`${DRIVE_BASE}/files/${fileId}?fields=id,name,mimeType`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) {
    return { name: fallbackName, kind: "unsupported" };
  }
  const meta = await metaRes.json<{ name: string; mimeType: string }>();

  // Google 原生文件（Docs/Slides）沒有二進位內容，要用 export
  if (meta.mimeType === "application/vnd.google-apps.document" || meta.mimeType === "application/vnd.google-apps.presentation") {
    const exportRes = await fetch(`${DRIVE_BASE}/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!exportRes.ok) return { name: meta.name, kind: "unsupported" };
    return { name: meta.name, kind: "text", text: await exportRes.text() };
  }

  if (meta.mimeType === DOCX_MIME) {
    const fileRes = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fileRes.ok) return { name: meta.name, kind: "unsupported" };
    const buf = await fileRes.arrayBuffer();
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

  const fileRes = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) return { name: meta.name, kind: "unsupported" };
  const buf = await fileRes.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);

  return { name: meta.name, kind: isPdf ? "pdf" : "image", base64, mimeType: meta.mimeType };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
