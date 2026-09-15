import * as XLSX from "@e965/xlsx";

/**
 * Gemini 讀不懂 Excel 的二進位格式（不像圖片/PDF能直接當多模態內容餵），
 * 老師上傳 Excel 答案檔時，要先在後端解析成文字表格，AI 才看得懂。
 */
export function extractExcelText(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const workbook = XLSX.read(bytes, { type: "array" });

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `【工作表：${sheetName}】\n${csv}`;
  }).join("\n\n");
}
