import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { setPending } from "../unsaved";
import { PhraseBar, RewriteBar } from "./FeedbackTools";
import { pushState } from "./GradingExtras";
import type { SimilarMatch } from "../similarity";
import {
  HISTORY_SOURCE_LABEL,
  hasTurnedIn,
  isResubmitted,
  parseAttachments,
  parseConfidenceFlags,
  parseItemScores,
  type Submission,
} from "../grading-utils";

export default function SubmissionCard({
  innerRef,
  submission,
  maxPoints,
  busy,
  failure,
  needsTeacher,
  similar,
  canWriteBack,
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
  needsTeacher?: string;
  similar?: SimilarMatch;
  canWriteBack: boolean;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onAiGrade: (force: boolean) => void;
  onSaved: () => Promise<void> | void;
  onConfirmed: () => void;
}) {
  // 分數用文字存：輸入框清空時 Number("") 會變成 0，老師以為沒填、其實存成 0 分
  const savedScore = submission.final_score ?? submission.ai_score;
  const savedScoreText = savedScore != null ? String(savedScore) : "";
  const savedFeedback = submission.final_feedback ?? submission.ai_feedback ?? "";
  const [scoreText, setScoreText] = useState(savedScoreText);
  const [feedback, setFeedback] = useState(savedFeedback);
  // v1.22.0 評語框隨內容長高，不用在小框裡捲；上限 60% 螢幕高，再長才出捲軸
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = feedbackRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.6))}px`;
  }, [feedback]);
  const [manual, setManual] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const scoreInputRef = useRef<HTMLInputElement | null>(null);
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
    setScoreText(savedScoreText);
    setFeedback(savedFeedback);
  }, [savedScoreText, savedFeedback]);

  const scoreNum = Number(scoreText);
  const scoreError =
    scoreText.trim() === ""
      ? `請填分數（0～${maxPoints} 分）`
      : !Number.isFinite(scoreNum)
        ? "分數只能填數字"
        : scoreNum < 0 || scoreNum > maxPoints
          ? `分數要在 0 到 ${maxPoints} 分之間`
          : "";
  const editorOpen = !!submission.status || manual;
  const hasAi = submission.ai_score != null;
  const dirty = editorOpen && (scoreText !== savedScoreText || feedback !== savedFeedback);

  // 改了還沒存：登記起來，關分頁、重新整理、按上一步都會先問一聲，不讓老師的修改默默消失
  useEffect(() => {
    const key = `card:${submission.id}`;
    setPending(key, dirty);
    return () => setPending(key, false);
  }, [dirty, submission.id]);
  const resubmitted = isResubmitted(submission);

  const confirmed = submission.status === "confirmed";
  const locked = submission.locked === 1;
  const itemScores = parseItemScores(submission.ai_raw_json);
  const attachments = parseAttachments(submission.attachments_json);
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

  // 會蓋掉老師改過的內容（或還沒存的字）時，第一次按只提醒，第二次按才真的請 AI 重評
  function requestAi() {
    const wouldOverwrite = submission.status === "teacher_edited" || dirty;
    if (wouldOverwrite && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    setConfirmOverwrite(false);
    onAiGrade(submission.status === "teacher_edited");
  }

  // 常用評語：插在游標處（沒聚焦就接在最後），插完把游標放回句子後面
  function insertPhrase(text: string) {
    const el = document.getElementById(`fb-${submission.id}`) as HTMLTextAreaElement | null;
    const start = el && el.selectionStart != null ? el.selectionStart : feedback.length;
    const end = el && el.selectionEnd != null ? el.selectionEnd : start;
    const before = feedback.slice(0, start);
    setFeedback(before + text + feedback.slice(end));
    const pos = (before + text).length;
    setTimeout(() => {
      el?.focus({ preventScroll: true });
      el?.setSelectionRange(pos, pos);
    }, 0);
  }

  // 快速加減分：空白當 0，不超出 0～滿分；小數（0.5 分）也不會被弄成長長的浮點數
  function nudgeScore(delta: number) {
    const cur = Number.isFinite(Number(scoreText)) && scoreText.trim() !== "" ? Number(scoreText) : 0;
    const next = Math.min(maxPoints, Math.max(0, Math.round((cur + delta) * 100) / 100));
    setScoreText(String(next));
  }

  async function save(confirm: boolean) {
    if (saving) return;
    if (scoreError) {
      // 分數有問題不送出：把游標放回分數欄，錯誤訊息就在旁邊
      setTriedSave(true);
      scoreInputRef.current?.focus();
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await api.updateGrade(submission.id, { finalScore: scoreNum, finalFeedback: feedback, confirm });
      setTriedSave(false);
      setManual(false);
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
    const text = `分數：${scoreText} ／ ${maxPoints}\n${feedback}`;
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
        : needsTeacher && !submission.status
          ? { cls: "failed", label: "要你自己批" }
        : submission.status
          ? { cls: "review", label: "等你確認" }
          : turnedIn
            ? { cls: "todo", label: "還沒評分" }
            : { cls: "waiting", label: "還沒繳交" };

  // 三色分流：老師還沒動過的 AI 建議才標，老師已經改過/確認過的不用再標（那已經是老師的判斷了）
  const RISK_BADGE: Record<"green" | "yellow" | "red", { cls: string; label: string }> = {
    green: { cls: "risk-green", label: "🟢 可直接確認" },
    yellow: { cls: "risk-yellow", label: "🟡 建議看一下" },
    red: { cls: "risk-red", label: "🔴 需要確認" },
  };
  const riskBadge =
    submission.status === "ai_suggested" && submission.risk_level ? RISK_BADGE[submission.risk_level] : null;
  // v1.22.0：發還給學生的狀態（只有 classAI 出的作業才顯示）
  const push = canWriteBack ? pushState(submission) : "not_ready";
  const pushBadge =
    push === "pushed" ? (
      <span className="badge pushed">已發還</span>
    ) : push === "stale" ? (
      <span className="badge push-stale" title="發還後你又改了分數或評語">
        學生看到的是 {submission.returned_score} 分的舊版，要再發還
      </span>
    ) : null;
  const similarBadge = similar ? (
    <span className="badge similar" title="只是提醒，請自己看兩份原文判斷">
      🟠 跟{similar.otherName}的作答很像（{similar.percent}%）
    </span>
  ) : null;

  // 已完成的卡片收成一行，全班頁面才不會越改越長
  if (confirmed && !expanded) {
    return (
      <div ref={innerRef} className="card submission-card collapsed">
        <div className="collapsed-row">
          <span className="muted collapsed-position">{position}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
          {riskBadge && <span className={`badge ${riskBadge.cls}`}>{riskBadge.label}</span>}
          <strong className="student-name">{submission.student_name}</strong>
          <span className="score-pill">
            {savedScoreText} ／ {maxPoints}
          </span>
          {resubmitted && <span className="badge review">學生重交了，請展開重看</span>}
          {pushBadge}
          {similarBadge}
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
          {riskBadge && <span className={`badge ${riskBadge.cls}`}>{riskBadge.label}</span>}
          {pushBadge}
          {similarBadge}
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

      {resubmitted && (
        <p className="warn-text" role="status">
          這位學生在你評分之後又重新交了作業，下面是新交的內容，但分數還是舊版本的。
          {locked ? "要改分數請先按「解鎖重新編輯」。" : "看過之後改分數，或按「請 AI 重評」。"}
        </p>
      )}
      {!turnedIn ? (
        <p className="muted small-text">這位學生還沒繳交這份作業，等他交了按「更新學生繳交」。</p>
      ) : submission.content_text ? (
        <div className={`submission-text ${longText && !showFull ? "clamped" : ""}`}>{submission.content_text}</div>
      ) : attachments.length > 0 ? (
        <p className="muted small-text">學生交的是檔案，點下面的檔名可以打開原檔。</p>
      ) : (
        <p className="muted small-text">學生按了繳交，但沒有寫內容，也沒有附檔案。</p>
      )}
      {longText && (
        <button className="ghost small" onClick={() => setShowFull(!showFull)}>
          {showFull ? "收起" : "看完整內容"}
        </button>
      )}
      {turnedIn && attachments.length > 0 && (
        <ul className="attachment-list" aria-label="學生交的檔案">
          {attachments.map((a, i) => (
            <li key={i}>
              {a.href ? (
                <a href={a.href} target="_blank" rel="noopener noreferrer">
                  📎 {a.name}
                </a>
              ) : (
                <span className="muted">📎 {a.name}（這個連結沒辦法直接打開，請到 Classroom 看）</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {failure && (
        <div className="fail-box" role="alert">
          {failure}
        </div>
      )}
      {!failure && needsTeacher && (
        <div className="fail-box" role="status">
          ✋ classAI 先幫你看過了，這位 AI 沒辦法評：{needsTeacher}
        </div>
      )}

      {editorOpen ? (
        <div className="result-box">
          {!submission.status && (
            <div className="result-box-hint">自己打分：填好分數和評語，按「完成批改」就算數。</div>
          )}
          {submission.status === "ai_suggested" && (
            <div className="result-box-hint">
              {riskBadge?.cls === "risk-green" && "各評分項目判斷都很穩定，這份可以直接採用，看過沒問題就按「完成批改」。"}
              {riskBadge?.cls === "risk-yellow" &&
                "這份分數落在比較極端的區間，或這份評分標準還沒有累積校準紀錄，建議多看一眼再確認。"}
              {(!riskBadge || riskBadge.cls === "risk-red") &&
                "這是 AI 的建議，看過沒問題就按「完成批改」，要改直接改。"}
            </div>
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
              step="any"
              ref={scoreInputRef}
              value={scoreText}
              disabled={locked}
              aria-invalid={!!scoreError}
              aria-describedby={`score-err-${submission.id}`}
              onChange={(e) => setScoreText(e.target.value)}
              className="input-short"
            />
            <span className="muted">／ {maxPoints}</span>
            {!locked && (
              <span className="score-quick" aria-label="快速調分">
                <button type="button" className="ghost small" onClick={() => nudgeScore(-1)} aria-label="減 1 分">
                  −1
                </button>
                <button type="button" className="ghost small" onClick={() => nudgeScore(1)} aria-label="加 1 分">
                  ＋1
                </button>
                <button type="button" className="ghost small" onClick={() => setScoreText(String(maxPoints))}>
                  滿分
                </button>
                <button type="button" className="ghost small" onClick={() => setScoreText("0")}>
                  0 分
                </button>
              </span>
            )}
          </div>
          {scoreError && (triedSave || scoreText !== savedScoreText) && (
            <p className="error-text" id={`score-err-${submission.id}`} role="alert">
              {scoreError}
            </p>
          )}

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
            ref={feedbackRef}
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
          {!locked && (
            <>
              <PhraseBar onInsert={insertPhrase} />
              <RewriteBar
                feedback={feedback}
                score={scoreNum}
                maxPoints={maxPoints}
                onResult={(t) => setFeedback(t)}
                disabled={saving || busy}
              />
            </>
          )}
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
              <button className={confirmOverwrite ? "warn" : "ghost"} onClick={requestAi} disabled={busy || saving}>
                {busy ? "評分中…" : confirmOverwrite ? "確定讓 AI 重評" : hasAi ? "請 AI 重評" : "請 AI 評分"}
              </button>
              {submission.status ? (
                <button className="ghost small" onClick={toggleHistory}>
                  {historyOpen ? "收起修改歷程" : "看修改歷程"}
                </button>
              ) : (
                <button
                  className="ghost small"
                  onClick={() => {
                    setManual(false);
                    setScoreText(savedScoreText);
                    setFeedback(savedFeedback);
                    setTriedSave(false);
                  }}
                  disabled={saving}
                >
                  取消
                </button>
              )}
            </div>
          )}
          {confirmOverwrite && (
            <div className="fail-box" role="alert">
              AI 重評會把{submission.status === "teacher_edited" ? "你改過的分數和評語" : "你剛打的字"}蓋掉，確定的話再按一次「確定讓 AI 重評」。
              <button className="ghost small" onClick={() => setConfirmOverwrite(false)}>
                算了
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
            {locked ? "這筆已確認鎖定，AI 重評與直接編輯都要先解鎖" : "電腦上可以按 Ctrl＋Enter 完成並跳到下一位，Alt＋←／→ 切換學生"}
            {submission.ai_model && `｜AI 模型：${submission.ai_model}`}
          </div>
        </div>
      ) : (
        <div className="row card-actions">
          <button className="card-grade-btn" onClick={() => onAiGrade(false)} disabled={busy || !turnedIn} title={!turnedIn ? "這位學生還沒繳交，交了才能評分" : undefined}>
            {busy ? "AI 評分中…" : !turnedIn ? "還沒繳交" : failure ? "請 AI 再評一次" : "請 AI 評這一位"}
          </button>
          {turnedIn && (
            <button className="secondary card-grade-btn" onClick={() => setManual(true)} disabled={busy}>
              自己打分
            </button>
          )}
        </div>
      )}
    </div>
  );
}
