import { useEffect, useState } from "react";
import { api } from "../api";
import { askConfirm, askText } from "../dialog";

/**
 * v1.21.0 評語欄下面的兩排工具：
 * - PhraseBar：常用評語庫，點一下把句子插進評語；老師自己新增、刪除
 * - RewriteBar：評語一鍵調整（更短／更鼓勵／更嚴格／一段話），只改評語不動分數，扣 1 次 AI
 */

// 評語庫每位老師一份，所有學生卡片共用：只讀一次，新增刪除時更新
let cache: { id: string; text: string }[] | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

function ensureLoaded() {
  if (cache || loading) return;
  loading = api
    .listPhrases()
    .then((r) => {
      cache = r.phrases;
    })
    .catch(() => {
      cache = []; // 讀不到就當空的，不擋老師批改
    })
    .finally(() => {
      loading = null;
      notify();
    });
}

export function PhraseBar({ onInsert, disabled }: { onInsert: (text: string) => void; disabled?: boolean }) {
  const [, force] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    ensureLoaded();
    return () => {
      listeners.delete(f);
    };
  }, []);

  async function add() {
    const text = await askText({
      title: "新增常用評語",
      message: "寫一句你常對學生說的話，之後批改時點一下就能插進評語。",
      maxLength: 120,
      okText: "儲存",
    });
    if (!text) return;
    setError("");
    try {
      const r = await api.addPhrase(text);
      cache = [...(cache ?? []).filter((p) => p.id !== r.id), { id: r.id, text: r.text }];
      notify();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(p: { id: string; text: string }) {
    const ok = await askConfirm({ title: "要刪除這句嗎？", message: `「${p.text}」`, okText: "刪除", danger: true });
    if (!ok) return;
    try {
      await api.deletePhrase(p.id);
      cache = (cache ?? []).filter((x) => x.id !== p.id);
      notify();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const list = cache ?? [];
  return (
    <div className="phrase-bar" aria-label="常用評語">
      <span className="muted small-text">常用評語：</span>
      <span className="chip-row phrase-row">
        {list.map((p) => (
          <span key={p.id} className="chip-with-delete">
            <button type="button" className="chip" disabled={disabled} onClick={() => onInsert(p.text)} title={p.text}>
              {p.text.length > 16 ? `${p.text.slice(0, 16)}…` : p.text}
            </button>
            <button type="button" className="ghost icon-btn small" aria-label={`刪除常用評語「${p.text}」`} onClick={() => remove(p)}>
              ✕
            </button>
          </span>
        ))}
        <button type="button" className="ghost small" onClick={add}>
          ＋ 新增
        </button>
      </span>
      {error && <span className="error-text small-text">{error}</span>}
    </div>
  );
}

const ACTIONS = [
  { key: "shorter", label: "更短" },
  { key: "warmer", label: "更鼓勵" },
  { key: "stricter", label: "更嚴格" },
  { key: "onepara", label: "改成一段話" },
] as const;

export function RewriteBar({
  feedback,
  score,
  maxPoints,
  onResult,
  disabled,
}: {
  feedback: string;
  score: number;
  maxPoints: number;
  onResult: (text: string) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const canRun = feedback.trim().length > 0 && Number.isFinite(score) && !disabled;

  async function run(action: (typeof ACTIONS)[number]["key"]) {
    if (!canRun || busy) return;
    setBusy(action);
    setError("");
    try {
      const r = await api.rewriteFeedback({ action, feedback, score, maxPoints });
      onResult(r.feedback);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rewrite-bar" aria-label="評語一鍵調整">
      <span className="muted small-text">讓 AI 改評語（用 1 次 AI，不動分數）：</span>
      {ACTIONS.map((a) => (
        <button key={a.key} type="button" className="ghost small" disabled={!canRun || !!busy} onClick={() => run(a.key)}>
          {busy === a.key ? "改寫中…" : a.label}
        </button>
      ))}
      {error && <span className="error-text small-text">{error}</span>}
    </div>
  );
}
