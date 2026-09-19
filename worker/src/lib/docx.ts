import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

/**
 * 學生上傳 Word (.docx) 附件時，讀出純文字給 Gemini。.docx 本質是一個 zip，
 * 文字都在 word/document.xml 的 <w:t> 標籤裡。不用 regex 直接抓 <w:t>：Word 常把
 * 同一個詞拆成好幾個 <w:t>（粗體切換、編輯痕跡），regex 抓到的片段會斷得亂七八糟，
 * 表格結構也會整個消失。改用真正的 XML parser 走樹，同段落內的 <w:t> 合併、
 * 表格用「|」分隔欄位，取得的內容不會100%還原Word排版，但AI看得懂就夠了。
 */
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
});

type XmlNode = Record<string, any>;

function collectText(node: XmlNode): string {
  const key = Object.keys(node).find((k) => k !== ":@");
  if (!key) return "";
  if (key === "w:t") {
    const val = node[key];
    if (typeof val === "string") return val;
    if (Array.isArray(val) && val.length && typeof val[0]["#text"] === "string") return val[0]["#text"];
    return "";
  }
  if (!Array.isArray(node[key])) return "";
  return node[key].map(collectText).join("");
}

function walkBody(nodes: XmlNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const key = Object.keys(node).find((k) => k !== ":@");
    if (!key) continue;
    if (key === "w:p") {
      lines.push(collectText(node));
    } else if (key === "w:tbl") {
      const rows = Array.isArray(node[key]) ? node[key] : [];
      for (const row of rows) {
        const rowKey = Object.keys(row).find((k) => k !== ":@");
        if (rowKey !== "w:tr") continue;
        const cells = Array.isArray(row[rowKey]) ? row[rowKey] : [];
        const cellTexts: string[] = [];
        for (const cell of cells) {
          const cellKey = Object.keys(cell).find((k) => k !== ":@");
          if (cellKey !== "w:tc") continue;
          const cellParas = Array.isArray(cell[cellKey]) ? cell[cellKey] : [];
          cellTexts.push(walkBody(cellParas).replace(/\n/g, " ").trim());
        }
        if (cellTexts.length) lines.push(cellTexts.join(" | "));
      }
    } else if (Array.isArray(node[key])) {
      // 其他容器節點（例如 w:sdt 內容控制項）遞迴往下找，不要漏掉裡面的文字
      lines.push(walkBody(node[key]));
    }
  }
  return lines.filter((l) => l.trim()).join("\n");
}

export function extractDocxText(bytes: Uint8Array): string {
  // 只解壓內文那一個檔：docx 裡的圖片可能幾十 MB，全部解開會吃光 Worker 記憶體。
  // 解壓後超過 20MB 的內文不正常（壓縮炸彈），直接當讀不到
  const MAX_XML_BYTES = 20 * 1024 * 1024;
  let tooBig = false;
  const unzipped = unzipSync(bytes, {
    filter: (f) => {
      if (f.name !== "word/document.xml") return false;
      if (f.originalSize > MAX_XML_BYTES) {
        tooBig = true;
        return false;
      }
      return true;
    },
  });
  if (tooBig) throw new Error("docx 內文解壓後超過 20MB");
  const xmlBytes = unzipped["word/document.xml"];
  if (!xmlBytes) return "";
  const xml = new TextDecoder().decode(xmlBytes);
  const parsed = parser.parse(xml) as XmlNode[];

  // 結構是 [{ "w:document": [ { "w:body": [...段落與表格...] } ] }]
  const documentNode = parsed.find((n) => "w:document" in n);
  const bodyWrap = documentNode?.["w:document"]?.find((n: XmlNode) => "w:body" in n);
  const body = bodyWrap?.["w:body"];
  if (!Array.isArray(body)) return "";
  return walkBody(body);
}
