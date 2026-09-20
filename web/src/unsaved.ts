/**
 * 「還沒存／還沒做完」登記處：批改卡片改了沒存、評分標準改了沒存、AI 批次評分進行中，都登記在這裡。
 * - 關分頁、重新整理：瀏覽器會先問一聲（beforeunload）
 * - App 內換頁（上一步、左上角 logo、登出）：用 confirmLeave() 先問
 * BrowserRouter 沒有內建的換頁攔截（useBlocker 要 data router），所以自己做這一層。
 */
const pending = new Set<string>();

export function setPending(key: string, on: boolean) {
  if (on) pending.add(key);
  else pending.delete(key);
}

// 被踢回登入頁時整個清掉（畫面已經換掉，沒東西可存了）
export function clearPending() {
  pending.clear();
}

export function hasPending(): boolean {
  return pending.size > 0;
}

// 沒有待處理的東西就直接放行；有的話問老師，按「確定」才離開
export function confirmLeave(): boolean {
  if (!pending.size) return true;
  const ok = window.confirm("有修改還沒存，或 AI 還在評分中。確定要離開這一頁嗎？離開後沒存的修改會不見。");
  if (ok) pending.clear();
  return ok;
}

window.addEventListener("beforeunload", (e) => {
  if (!pending.size) return;
  e.preventDefault();
  e.returnValue = "";
});
