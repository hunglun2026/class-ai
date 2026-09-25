import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FeedbackStyle as Style } from "../api";

/**
 * v1.19.0 評語風格：AI 寫給學生的評語用什麼格式、語氣、長度，也可以貼自己寫過的評語讓 AI 學口吻。
 * 每位老師一套，套用在之後所有 AI 評分（含背景自動預批）；已經評好的不會重寫。
 */

const FORMATS: { key: Style["format"]; label: string; desc: string }[] = [
  { key: "three", label: "三段式", desc: "【做得好】【可以更好】【下一步】，學生一看就知道優點、問題和怎麼改" },
  { key: "two", label: "兩段式", desc: "【做得好】【可以更好】，比三段短一點" },
  { key: "one", label: "一段話", desc: "像老師在作業上手寫的短評，不分段" },
];
const TONES: { key: Style["tone"]; label: string; desc: string }[] = [
  { key: "warm", label: "溫暖鼓勵", desc: "先肯定再建議" },
  { key: "concise", label: "簡潔直接", desc: "講重點、不說客套話" },
  { key: "lively", label: "活潑親切", desc: "像面對面聊天" },
];
const LENGTHS: { key: Style["length"]; label: string }[] = [
  { key: "short", label: "短" },
  { key: "medium", label: "中" },
  { key: "long", label: "長" },
];
const MAX_SAMPLES = 3;

function Choice<T extends string>({
  name,
  options,
  value,
  onChange,
  compact = false,
}: {
  compact?: boolean;
  name: string;
  options: { key: T; label: string; desc?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className={`style-choices ${compact ? "compact" : ""}`} role="radiogroup">
      {options.map((o) => (
        <label key={o.key} className={`style-choice ${value === o.key ? "active" : ""}`}>
          <input type="radio" name={name} checked={value === o.key} onChange={() => onChange(o.key)} />
          <span>
            <strong>{o.label}</strong>
            {o.desc && <span className="muted small-text">{o.desc}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

export default function FeedbackStyle() {
  const [style, setStyle] = useState<Style | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ sampleAnswer: string; feedback: string } | null>(null);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    api
      .getFeedbackStyle()
      .then((r) => setStyle({ ...r.style, samples: r.style.samples.length ? r.style.samples : [""] }))
      .catch((e) => setError(e.message));
  }, []);

  if (!style) return <div>{error ? <p className="error-text">{error}</p> : <p className="muted">載入中…</p>}</div>;

  const update = (patch: Partial<Style>) => {
    setStyle({ ...style, ...patch });
    setSaved(false);
  };
  const cleanSamples = style.samples.map((t) => t.trim()).filter(Boolean);
  const payload: Style = { ...style, samples: cleanSamples };

  async function save() {
    setSaving(true);
    setError("");
    try {
      await api.saveFeedbackStyle(payload);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function tryIt() {
    setPreviewing(true);
    setPreviewError("");
    try {
      const r = await api.previewFeedbackStyle(payload);
      setPreview({ sampleAnswer: r.sampleAnswer, feedback: r.feedback });
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div>
      <Link to="/" className="back-link">
        ← 回課程列表
      </Link>
      <div className="page-head">
        <h1 className="page-title">評語風格</h1>
        <p className="page-sub">設定 AI 寫給學生的評語要用什麼格式和口氣。之後所有 AI 評分都照這個寫（已經評好的不會重寫）。</p>
      </div>

      <div className="card">
        <h2 className="card-title">格式</h2>
        <Choice name="format" options={FORMATS} value={style.format} onChange={(v) => update({ format: v })} />

        <h2 className="card-title style-gap">語氣</h2>
        <Choice name="tone" options={TONES} value={style.tone} onChange={(v) => update({ tone: v })} />

        <h2 className="card-title style-gap">長度</h2>
        <Choice name="length" options={LENGTHS} value={style.length} onChange={(v) => update({ length: v })} compact />

        <h2 className="card-title style-gap">我平常寫的評語（選填）</h2>
        <p className="small-text muted">貼幾則你以前寫給學生的評語，AI 會學你的用詞、稱呼學生的方式和口氣，但不會照抄。最多 {MAX_SAMPLES} 則，每則 500 字內。</p>
        {style.samples.map((t, i) => (
          <div key={i} className="sample-row">
            <textarea
              rows={2}
              maxLength={500}
              aria-label={`範例評語 ${i + 1}`}
              placeholder="例如：小明，你把實驗步驟寫得很清楚喔！下次記得把觀察到的結果也寫進去，會更完整～"
              value={t}
              onChange={(e) => {
                const next = [...style.samples];
                next[i] = e.target.value;
                update({ samples: next });
              }}
            />
            {style.samples.length > 1 && (
              <button
                type="button"
                className="ghost icon-btn"
                aria-label={`刪除範例評語 ${i + 1}`}
                onClick={() => update({ samples: style.samples.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {style.samples.length < MAX_SAMPLES && (
          <button type="button" className="secondary small" onClick={() => update({ samples: [...style.samples, ""] })}>
            ＋ 再加一則
          </button>
        )}

        <div className="form-footer">
          <button onClick={save} disabled={saving}>
            {saving ? "儲存中…" : "儲存評語風格"}
          </button>
          <button className="secondary" onClick={tryIt} disabled={previewing}>
            {previewing ? "AI 試寫中…" : "用這個設定試寫一則"}
          </button>
          {saved && <span className="ok-text">已儲存，之後的 AI 評分會照這個風格寫</span>}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <p className="small-text muted">試寫用的是一份範例作答（不是你學生的作業），用 1 次 AI 次數，不會改到已儲存的設定。</p>
        {previewError && (
          <p className="error-text" role="alert">
            {previewError}
          </p>
        )}
        {preview && (
          <div className="style-preview" role="status">
            <p className="small-text muted">範例作答：{preview.sampleAnswer}</p>
            <p className="style-preview-feedback">{preview.feedback}</p>
          </div>
        )}
      </div>
    </div>
  );
}
