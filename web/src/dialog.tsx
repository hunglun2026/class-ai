/**
 * classAI 自己的對話框，取代瀏覽器內建的 window.confirm／prompt（內建的長相跟網站無關，
 * 顯示「classai.hunglun.com 顯示」，老師看不懂也不好按；自動化測試也會被直接按取消）。
 * 用法：const ok = await askConfirm({ message: "…" });  const name = await askText({ message: "…" });
 * <DialogHost /> 掛在 App 最外層一次就好。
 */
import { useEffect, useRef, useState } from "react";

interface ConfirmOpts {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface TextOpts {
  title?: string;
  message: string;
  placeholder?: string;
  maxLength?: number;
  okText?: string;
}
type Req =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "text"; opts: TextOpts; resolve: (v: string | null) => void };

let show: ((r: Req) => void) | null = null;

export function askConfirm(opts: ConfirmOpts): Promise<boolean> {
  // 還沒掛好（不該發生）就當作取消，寧可不做也不要誤刪
  if (!show) return Promise.resolve(false);
  return new Promise((resolve) => show!({ kind: "confirm", opts, resolve }));
}

export function askText(opts: TextOpts): Promise<string | null> {
  if (!show) return Promise.resolve(null);
  return new Promise((resolve) => show!({ kind: "text", opts, resolve }));
}

export function DialogHost() {
  const [queue, setQueue] = useState<Req[]>([]);
  const [text, setText] = useState("");
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cur = queue[0];

  useEffect(() => {
    show = (r) => setQueue((q) => [...q, r]);
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (!cur) return;
    setText("");
    // 文字框直接讓老師打字；確認框停在主要按鈕，Enter 就能確定，Esc 取消
    (cur.kind === "text" ? inputRef.current : okRef.current)?.focus();
  }, [cur]);

  function finish(ok: boolean) {
    if (!cur) return;
    if (cur.kind === "confirm") cur.resolve(ok);
    else cur.resolve(ok ? text.trim() : null);
    setQueue((q) => q.slice(1));
  }

  if (!cur) return null;
  const isConfirm = cur.kind === "confirm";
  const title = cur.opts.title ?? (isConfirm ? "請確認" : "請輸入");
  const danger = cur.kind === "confirm" && cur.opts.danger;
  const cancelText = cur.kind === "confirm" ? (cur.opts.cancelText ?? "取消") : "取消";
  return (
    <div className="dlg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(false);
          if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) finish(true);
        }}
      >
        <h2 id="dlg-title" className="dlg-title">
          {title}
        </h2>
        <p className="dlg-msg">{cur.opts.message}</p>
        {cur.kind === "text" && (
          <input
            ref={inputRef}
            type="text"
            value={text}
            placeholder={cur.opts.placeholder}
            maxLength={cur.opts.maxLength}
            onChange={(e) => setText(e.target.value)}
            aria-label={title}
          />
        )}
        <div className="dlg-actions">
          <button type="button" className="secondary" onClick={() => finish(false)}>
            {cancelText}
          </button>
          <button ref={okRef} type="button" className={danger ? "dlg-danger" : ""} onClick={() => finish(true)}>
            {cur.opts.okText ?? "確定"}
          </button>
        </div>
      </div>
    </div>
  );
}
