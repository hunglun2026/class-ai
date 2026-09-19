import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";
import { MODE_LABEL, type AssignmentState, type Mode } from "./RubricSetup";

interface Submission {
  id: string;
  student_id: string;
  student_name: string;
  state: string;
  content_text: string;
  ai_score: number | null;
  ai_feedback: string | null;
  final_score: number | null;
  final_feedback: string | null;
  status: "ai_suggested" | "teacher_edited" | "confirmed" | null;
  ai_model: string | null;
  ai_raw_json: string | null;
  locked: number | null;
  confidence_flags: string | null;
}

function parseConfidenceFlags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type Filter = "all" | "todo" | "review" | "done" | "failed";

const BATCH_CONCURRENCY = 3;

// 跟後端 submissions.ts 的 turnedIn 判斷一致：state 是 Classroom 原始值（NEW/CREATED/
// TURNED_IN/RETURNED/RECLAIMED_BY_STUDENT），不是老師改分的狀態
function hasTurnedIn(s: Submission): boolean {
  return s.state === "TURNED_IN" || s.state === "RETURNED";
}

const HISTORY_SOURCE_LABEL: Record<string, string> = {
  AI_INITIAL: "AI 初評",
  AI_REGRADE: "AI 重新評分",
  TEACHER_EDIT: "老師修改",
  TEACHER_CONFIRM: "老師確認定案",
  TEACHER_REOPEN: "老師解鎖重編輯",
};

export default function Grading() {
  const { courseId, courseWorkId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const assignment = (location.state as AssignmentState | null) ?? null;
  const [rubric, setRubric] = useState<any>(undefined);
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // 評分失敗的學生與原因，只記在這次畫面上（重新評分成功就拿掉）
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const setupPath = `/courses/${courseId}/coursework/${courseWorkId}/setup`;

  useEffect(() => {
    if (!courseWorkId) return;
    api
      .getRubric(courseWorkId)
      .then((r) => {
        // 還沒設定評分標準就先去第 3 步，不讓老師在這頁看到一排按不下去的按鈕
        if (!r.rubric) navigate(setupPath, { state: assignment, replace: true });
        else setRubric(r.rubric);
      })
      .catch((e) => setError(e.message));
    // 先讀快取；第一次來（快取是空的）就自動去 Classroom 抓，不用老師自己找按鈕
    api
      .listSubmissions(courseWorkId)
      .then((r) => {
        if (r.submissions.length) setSubmissions(r.submissions);
        else syncSubmissions();
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseWorkId]);

  async function refreshSubmissions() {
    if (!courseWorkId) return;
    const r = await api.listSubmissions(courseWorkId);
    setSubmissions(r.submissions);
  }

  async function syncSubmissions() {
    if (!courseId || !courseWorkId) return;
    setSyncing(true);
    setError("");
    try {
      const r = await api.syncSubmissions(courseId, courseWorkId);
      setSubmissions(r.submissions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function downloadGrades() {
    if (!courseWorkId) return;
    setDownloading(true);
    setError("");
    try {
      await api.downloadExport(courseWorkId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  function markBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function gradeOne(s: Submission) {
    markBusy(s.id, true);
    try {
      const { grade, model, confidenceFlags } = await api.aiGrade(s.id);
      // 後端已經回傳這位學生的完整結果，直接合併進本地狀態就好，不用整班重拉一次
      // （跟後端 ai-grade 路由的 UPSERT 邏輯對齊：final_score/final_feedback 初始值＝AI 建議值）
      setSubmissions((prev) =>
        (prev ?? []).map((row) =>
          row.id === s.id
            ? {
                ...row,
                ai_score: grade.score,
                ai_feedback: grade.feedback,
                final_score: grade.score,
                final_feedback: grade.feedback,
                status: "ai_suggested",
                ai_model: model,
                ai_raw_json: JSON.stringify(grade),
                confidence_flags: confidenceFlags.length > 0 ? JSON.stringify(confidenceFlags) : null,
                locked: 0,
              }
            : row
        )
      );
      setFailures((prev) => {
        const { [s.id]: _, ...rest } = prev;
        return rest;
      });
    } catch (e) {
      setFailures((prev) => ({ ...prev, [s.id]: (e as Error).message }));
    } finally {
      markBusy(s.id, false);
    }
  }

  // 同時最多評 3 位；每評完一位就刷新，結果一個一個出現，不用等全班跑完
  async function gradeMany(list: Submission[]) {
    if (!list.length) return;
    const queue = [...list];
    let done = 0;
    setBatch({ done: 0, total: list.length });
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        if (!s) return;
        await gradeOne(s);
        done += 1;
        setBatch({ done, total: list.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, list.length) }, worker));
    setBatch(null);
  }

  const list = submissions ?? [];
  // 還沒繳交的學生（state 不是 TURNED_IN/RETURNED）沒東西可評，不算進「還沒評分」，
  // 也不會被批次評分抓進去——不然點下去只會送出註定失敗的請求，白白佔一個併發名額
  const counts = useMemo(
    () => ({
      all: list.length,
      todo: list.filter((s) => !s.status && hasTurnedIn(s)).length,
      review: list.filter((s) => s.status === "ai_suggested" || s.status === "teacher_edited").length,
      done: list.filter((s) => s.status === "confirmed").length,
      failed: list.filter((s) => failures[s.id]).length,
    }),
    [list, failures]
  );
  const ungraded = list.filter((s) => !s.status && !failures[s.id] && hasTurnedIn(s));
  const failedList = list.filter((s) => failures[s.id]);

  const visible = list.filter((s) => {
    if (filter === "todo") return !s.status && hasTurnedIn(s);
    if (filter === "review") return s.status === "ai_suggested" || s.status === "teacher_edited";
    if (filter === "done") return s.status === "confirmed";
    if (filter === "failed") return !!failures[s.id];
    return true;
  });

  function goTo(id: string | undefined, focusFeedback = false) {
    if (!id) return;
    const el = cardRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (focusFeedback) {
      // 等捲動開始再聚焦，避免 iOS 聚焦時自己又跳一次
      setTimeout(() => el.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }), 350);
    }
  }

  // 完成一位後跳到下一位還沒完成的學生
  function goNextUnfinished(fromId: string) {
    const idx = visible.findIndex((s) => s.id === fromId);
    const next = [...visible.slice(idx + 1), ...visible.slice(0, idx)].find(
      (s) => s.status !== "confirmed" && s.id !== fromId
    );
    goTo(next?.id, true);
  }

  const maxPoints = rubric?.maxPoints ?? rubric?.max_points ?? assignment?.maxPoints ?? 100;
  // 進度以「有交作業的人」為分母：班上只要有一位缺交，用全班人數當分母就永遠到不了
  // 100%，「全班都批改完了」的提示也永遠不會出現，即使老師該做的都做完了
  const gradableCount = list.filter(hasTurnedIn).length;
  const allDone = gradableCount > 0 && counts.done === gradableCount;
  const percent = gradableCount ? Math.round((counts.done / gradableCount) * 100) : 0;

  const FILTERS: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "全部", n: counts.all },
    { key: "todo", label: "還沒評分", n: counts.todo },
    { key: "review", label: "等你確認", n: counts.review },
    { key: "done", label: "已完成", n: counts.done },
    ...(counts.failed ? [{ key: "failed" as Filter, label: "評分失敗", n: counts.failed }] : []),
  ];

  return (
    <div>
      <Stepper current={3} />
      <Link to={`/courses/${courseId}`} state={{ courseName: assignment?.courseName }} className="back-link">
        ← 上一步：換一份作業
      </Link>

      <div className="page-head">
        <div className="eyebrow">第 4 步</div>
        <h1 className="page-title">{assignment?.title ?? "批改學生作業"}</h1>
      </div>

      {rubric && (
        <div className="summary-bar">
          <div>
            <span className="muted">評分方式：</span>
            <strong>{MODE_LABEL[rubric.mode as Mode]}</strong>
            <span className="muted">（總分 {maxPoints} 分）</span>
            {rubric.answerKeyFile && <span className="muted">｜答案檔：{rubric.answerKeyFile.name}</span>}
          </div>
          <Link to={setupPath} state={assignment} className="link-btn">
            修改評分標準
          </Link>
        </div>
      )}

      <p className="trust-note">
        AI 給的分數和評語只是草稿，不會寫回 Google Classroom；要看過、按「完成批改」才算數。
      </p>

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar card">
        <div className="progress-wrap" aria-label={`已完成 ${counts.done} 位，共 ${gradableCount} 位有交作業`}>
          <div className="progress-label">
            已完成 <strong>{counts.done}</strong> ／ {gradableCount} 位（已交作業的人數）
          </div>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="row toolbar-actions">
          {ungraded.length > 0 && (
            <button onClick={() => gradeMany(ungraded)} disabled={!!batch || !rubric}>
              讓 AI 評分還沒評的 {ungraded.length} 位
            </button>
          )}
          {failedList.length > 0 && !batch && (
            <button className="warn" onClick={() => gradeMany(failedList)}>
              只重評失敗的 {failedList.length} 位
            </button>
          )}
          <button className="secondary" onClick={syncSubmissions} disabled={syncing || !!batch}>
            {syncing ? "更新中…" : "更新學生繳交"}
          </button>
          {list.length > 0 && courseWorkId && (
            <button className="secondary" onClick={downloadGrades} disabled={downloading || !!batch}>
              {downloading ? "準備檔案中…" : "下載成績表（Excel）"}
            </button>
          )}
        </div>
        {batch && (
          <div className="batch-note" role="status">
            AI 正在評第 {Math.min(batch.done + 1, batch.total)}／{batch.total} 位。全部大約要 1～3
            分鐘，可以先切到別的分頁，但不要關掉這一頁。
          </div>
        )}
      </div>

      {allDone && (
        <div className="done-banner">
          <img src="/illust/done.webp" alt="" width={120} height={120} />
          <div>
            <strong>全班都批改完了！</strong>
            <p>按每張卡片的「複製分數與評語」貼回 Classroom，或下載 Excel 成績表對照登記。</p>
          </div>
        </div>
      )}

      {list.length > 0 && (
        <div className="filter-row" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`filter-chip ${filter === f.key ? "active" : ""} ${f.key}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span className="count">{f.n}</span>
            </button>
          ))}
        </div>
      )}

      {submissions === null && !error && <p className="muted">{syncing ? "正在從 Classroom 抓學生繳交…" : "載入中…"}</p>}
      {submissions?.length === 0 && !syncing && (
        <div className="empty-state">
          <img src="/illust/empty.webp" alt="" width={140} height={140} />
          <p>這份作業還沒有學生繳交。學生交了之後，按上面的「更新學生繳交」就會出現。</p>
        </div>
      )}
      {list.length > 0 && visible.length === 0 && <p className="muted">這個分類目前沒有學生。</p>}

      {visible.map((s, i) => (
        <SubmissionCard
          key={s.id}
          innerRef={(el) => (cardRefs.current[s.id] = el)}
          submission={s}
          maxPoints={maxPoints}
          busy={busyIds.has(s.id)}
          failure={failures[s.id]}
          position={`${i + 1}／${visible.length}`}
          onPrev={i > 0 ? () => goTo(visible[i - 1].id) : undefined}
          onNext={i < visible.length - 1 ? () => goTo(visible[i + 1].id) : undefined}
          onAiGrade={() => gradeOne(s)}
          onSaved={refreshSubmissions}
          onConfirmed={() => goNextUnfinished(s.id)}
        />
      ))}
    </div>
  );
}

function parseItemScores(raw: string | null): { item: string; score: number; comment?: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.itemScores) ? parsed.itemScores : [];
  } catch {
    return [];
  }
}

function SubmissionCard({
  innerRef,
  submission,
  maxPoints,
  busy,
  failure,
  position,
  onPrev,
  onNext,
  onAiGrade,
  onSaved,
  onConfirmed,
}: {
  innerRef: (el: HTMLDivElement | null) => void;
  submission: Submission;
  maxPoints: number;
  busy: boolean;
  failure?: string;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onAiGrade: () => void;
  onSaved: () => Promise<void> | void;
  onConfirmed: () => void;
}) {
  const [score, setScore] = useState(submission.final_score ?? submission.ai_score ?? 0);
  const [feedback, setFeedback] = useState(submission.final_feedback ?? submission.ai_feedback ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showItems, setShowItems] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  const [history, setHistory] = useState<
    { version_number: number; source: string; score: number | null; feedback: string | null; changed_at: number }[] | null
  >(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setScore(submission.final_score ?? submission.ai_score ?? 0);
    setFeedback(submission.final_feedback ?? submission.ai_feedback ?? "");
  }, [submission.final_score, submission.ai_score, submission.final_feedback, submission.ai_feedback]);

  const confirmed = submission.status === "confirmed";
  const locked = submission.locked === 1;
  const itemScores = parseItemScores(submission.ai_raw_json);
  const confidenceFlags = parseConfidenceFlags(submission.confidence_flags);
  const longText = (submission.content_text?.length ?? 0) > 220;

  async function unlock() {
    setUnlocking(true);
    setUnlockError("");
    try {
      await api.unlockGrade(submission.id);
      await onSaved();
    } catch (e) {
      setUnlockError(`解鎖沒有成功：${(e as Error).message}`);
    } finally {
      setUnlocking(false);
    }
  }

  async function toggleHistory() {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    if (history) return;
    setHistoryLoading(true);
    try {
      const r = await api.gradeHistory(submission.id);
      setHistory(r.history);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function save(confirm: boolean) {
    setSaving(true);
    setSaveError("");
    try {
      await api.updateGrade(submission.id, { finalScore: score, finalFeedback: feedback, confirm });
      await onSaved();
      if (confirm) {
        setExpanded(false);
        onConfirmed();
      }
    } catch (e) {
      setSaveError(`沒有存成功：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    const text = `分數：${score} ／ ${maxPoints}\n${feedback}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 舊瀏覽器或非 https 時退回 execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const turnedIn = hasTurnedIn(submission);
  const badge = failure
    ? { cls: "failed", label: "評分失敗" }
    : busy
      ? { cls: "busy", label: "AI 評分中…" }
      : confirmed
        ? { cls: "confirmed", label: "已完成" }
        : submission.status
          ? { cls: "review", label: "等你確認" }
          : turnedIn
            ? { cls: "todo", label: "還沒評分" }
            : { cls: "waiting", label: "還沒繳交" };

  // 已完成的卡片收成一行，全班頁面才不會越改越長
  if (confirmed && !expanded) {
    return (
      <div ref={innerRef} className="card submission-card collapsed">
        <div className="collapsed-row">
          <span className="muted collapsed-position">{position}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
          <strong className="student-name">{submission.student_name}</strong>
          <span className="score-pill">
            {score} ／ {maxPoints}
          </span>
          <button className="secondary small" onClick={copy}>
            {copied ? "已複製" : "複製分數與評語"}
          </button>
          <button className="ghost small" onClick={() => setExpanded(true)}>
            展開
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={innerRef} className={`card submission-card status-${badge.cls}`}>
      <div className="card-head">
        <div className="row">
          <strong className="student-name">{submission.student_name}</strong>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
        </div>
        <div className="row nav-mini">
          <span className="muted">{position}</span>
          <button className="ghost small" onClick={onPrev} disabled={!onPrev} aria-label="上一位">
            ‹ 上一位
          </button>
          <button className="ghost small" onClick={onNext} disabled={!onNext} aria-label="下一位">
            下一位 ›
          </button>
        </div>
      </div>

      {!turnedIn ? (
        <p className="muted small-text">這位學生還沒繳交這份作業，等他交了按「更新學生繳交」。</p>
      ) : submission.content_text ? (
        <div className={`submission-text ${longText && !showFull ? "clamped" : ""}`}>{submission.content_text}</div>
      ) : (
        <p className="muted small-text">學生交的是檔案，AI 評分時會一起讀。</p>
      )}
      {longText && (
        <button className="ghost small" onClick={() => setShowFull(!showFull)}>
          {showFull ? "收起" : "看完整內容"}
        </button>
      )}

      {failure && (
        <div className="fail-box" role="alert">
          {failure}
        </div>
      )}

      {submission.status ? (
        <div className="result-box">
          {submission.status === "ai_suggested" && (
            <div className="result-box-hint">這是 AI 的建議，看過沒問題就按「完成批改」，要改直接改。</div>
          )}
          {confidenceFlags.length > 0 && (
            <div className="confidence-warning" role="alert">
              ⚠️ 這筆建議再仔細看一下：
              <ul>
                {confidenceFlags.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="row field-row">
            <label className="field-label" htmlFor={`score-${submission.id}`}>
              分數
            </label>
            <input
              id={`score-${submission.id}`}
              type="number"
              inputMode="decimal"
              min={0}
              max={maxPoints}
              value={score}
              disabled={locked}
              onChange={(e) => setScore(Number(e.target.value))}
              className="input-short"
            />
            <span className="muted">／ {maxPoints}</span>
          </div>

          {itemScores.length > 0 && (
            <div className="item-scores">
              <button className="ghost small" onClick={() => setShowItems(!showItems)} aria-expanded={showItems}>
                {showItems ? "▾" : "▸"} 各項得分：
                {itemScores.map((it) => `${it.item} ${it.score}`).join("｜")}
              </button>
              {showItems && (
                <ul>
                  {itemScores.map((it) => (
                    <li key={it.item}>
                      <strong>
                        {it.item} {it.score} 分
                      </strong>
                      {it.comment && `：${it.comment}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <label className="field-label block" htmlFor={`fb-${submission.id}`}>
            給學生的評語
          </label>
          <textarea
            id={`fb-${submission.id}`}
            rows={5}
            value={feedback}
            disabled={locked}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              // Enter 照常換行；Ctrl（Mac 用 Cmd）＋Enter 才是完成並跳下一位
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !saving) {
                e.preventDefault();
                save(true);
              }
            }}
          />
          {saveError && <p className="error-text">{saveError}</p>}
          {unlockError && <p className="error-text">{unlockError}</p>}
          {locked ? (
            <div className="row card-actions">
              <button className="secondary" onClick={copy}>
                {copied ? "已複製" : "複製分數與評語"}
              </button>
              <button className="ghost" onClick={unlock} disabled={unlocking}>
                {unlocking ? "解鎖中…" : "🔓 解鎖重新編輯"}
              </button>
              <button className="ghost small" onClick={toggleHistory}>
                {historyOpen ? "收起修改歷程" : "看修改歷程"}
              </button>
            </div>
          ) : (
            <div className="row card-actions">
              <button onClick={() => save(true)} disabled={saving}>
                完成批改
              </button>
              <button className="secondary" onClick={() => save(false)} disabled={saving}>
                先存起來
              </button>
              <button className="secondary" onClick={copy}>
                {copied ? "已複製" : "複製分數與評語"}
              </button>
              <button className="ghost" onClick={onAiGrade} disabled={busy}>
                {busy ? "評分中…" : "請 AI 重評"}
              </button>
              <button className="ghost small" onClick={toggleHistory}>
                {historyOpen ? "收起修改歷程" : "看修改歷程"}
              </button>
            </div>
          )}
          {historyOpen && (
            <div className="history-box">
              {historyLoading && <p className="muted small-text">載入中…</p>}
              {!historyLoading && history?.length === 0 && <p className="muted small-text">還沒有任何修改紀錄。</p>}
              {!historyLoading && history && history.length > 0 && (
                <ul>
                  {history.map((h) => (
                    <li key={h.version_number}>
                      <strong>{HISTORY_SOURCE_LABEL[h.source] ?? h.source}</strong>
                      {h.score != null && ` ｜ ${h.score} 分`}
                      <span className="muted"> ｜ {new Date(h.changed_at * 1000).toLocaleString("zh-TW")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="hint-line muted">
            {locked ? "這筆已確認鎖定，AI 重評與直接編輯都要先解鎖" : "電腦上可以按 Ctrl＋Enter 完成並跳到下一位"}
            {submission.ai_model && `｜AI 模型：${submission.ai_model}`}
          </div>
        </div>
      ) : (
        <button className="card-grade-btn" onClick={onAiGrade} disabled={busy || !turnedIn} title={!turnedIn ? "這位學生還沒繳交，交了才能評分" : undefined}>
          {busy ? "AI 評分中…" : !turnedIn ? "還沒繳交" : failure ? "再評一次" : "請 AI 評這一位"}
        </button>
      )}
    </div>
  );
}
