import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";
import SafeLink from "../components/SafeLink";
import { setPending } from "../unsaved";
import { askConfirm } from "../dialog";
import { MODE_LABEL, type AssignmentState, type Mode } from "./RubricSetup";
import { InsightsPanel, WritebackPanel } from "../components/GradingExtras";
import { findSimilar, type SimilarMatch } from "../similarity";
import SubmissionCard from "../components/SubmissionCard";
import { hasTurnedIn, isResubmitted, needsTeacher, type Submission } from "../grading-utils";

type Filter = "all" | "todo" | "review" | "done" | "failed" | "resubmitted" | "manual";

const BATCH_CONCURRENCY = 3;

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
  const [copiedAll, setCopiedAll] = useState(false);
  // v1.18.0：這份作業能不能把分數送回 Classroom（classAI 出的才行）、老師有沒有給寫入權限
  const [writeback, setWriteback] = useState<{ canWriteBack: boolean; canWrite: boolean }>({ canWriteBack: false, canWrite: false });
  const [insightsKey, setInsightsKey] = useState(0);
  const [confirming, setConfirming] = useState<{ done: number; total: number } | null>(null);
  const [confirmMsg, setConfirmMsg] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  // 今天還能讓 AI 評幾份（所有老師共用一把 AI 金鑰，每人每天有上限）
  const [remaining, setRemaining] = useState<number | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const setupPath = `/courses/${courseId}/coursework/${courseWorkId}/setup`;

  // AI 批次評分進行中關分頁或換頁，剩下的學生就不會評了，先問一聲
  useEffect(() => {
    setPending("batch", !!batch);
    return () => setPending("batch", false);
  }, [batch]);

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
    // 這份作業交給背景自動預批（v1.17.0）；登記失敗不影響老師在這頁做事
    api.watchCourseWork(courseWorkId).catch(() => {});
    // 先讀快取；第一次來（快取是空的）就自動去 Classroom 抓，不用老師自己找按鈕
    api
      .listSubmissions(courseWorkId)
      .then((r) => {
        setWriteback({ canWriteBack: !!r.canWriteBack, canWrite: !!r.canWrite });
        if (r.submissions.length) setSubmissions(r.submissions);
        else syncSubmissions();
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseWorkId]);

  useEffect(() => {
    api
      .usage()
      .then((u) => setRemaining(u.remainingToday))
      .catch(() => setRemaining(null)); // 讀不到就不顯示，不擋老師做事
  }, []);

  // 老師打開時看到的應該是「已經評好」的結果，不是一份一份按：已繳交還沒評的學生自動評。
  // 每位學生只自動試一次（失敗的留給「只重評失敗的」），且只評到今天剩餘額度為止
  const autoTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!rubric || !submissions || batch || remaining === null || remaining <= 0) return;
    // 背景已經判定 AI 評不了的不再自動送（老師可以在卡片上自己按「請 AI 評」）
    const todo = submissions.filter((s) => !s.status && hasTurnedIn(s) && !s.autograde_error && !autoTried.current.has(s.id));
    if (!todo.length) return;
    const chosen = todo.slice(0, remaining);
    chosen.forEach((s) => autoTried.current.add(s.id));
    gradeMany(chosen, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubric, submissions, batch, remaining]);

  async function refreshSubmissions() {
    if (!courseWorkId) return;
    const r = await api.listSubmissions(courseWorkId);
    setWriteback({ canWriteBack: !!r.canWriteBack, canWrite: !!r.canWrite });
    setSubmissions(r.submissions);
    setInsightsKey((k) => k + 1);
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

  // 登分助手：Classroom API 技術上不能寫回老師手動建立的作業（Google 的權限設計，見進度.md），
  // 所以不做自動寫回，改把已經有分數的學生整理成「姓名 + 分數」貼進剪貼簿，
  // 順序跟這頁一致，老師到 Classroom 成績簿貼上去比對著填，比逐一切換視窗手抄快很多。
  async function copyAllGrades() {
    const graded = list.filter((s) => s.final_score != null && (s.status === "ai_suggested" || s.status === "teacher_edited" || s.status === "confirmed"));
    const text = graded.map((s) => `${s.student_name}\t${s.final_score}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  }

  function markBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function clearFailure(id: string) {
    setFailures((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }

  async function gradeOne(s: Submission, force = false) {
    markBusy(s.id, true);
    try {
      const { grade, model, confidenceFlags, riskLevel, remainingToday } = await api.aiGrade(s.id, force);
      setRemaining(remainingToday);
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
                risk_level: riskLevel,
                locked: 0,
              }
            : row
        )
      );
      clearFailure(s.id);
    } catch (e) {
      setFailures((prev) => ({ ...prev, [s.id]: (e as Error).message }));
    } finally {
      markBusy(s.id, false);
    }
  }

  // 同時最多評 3 位；每評完一位就刷新，結果一個一個出現，不用等全班跑完
  async function gradeMany(list: Submission[], auto = false) {
    if (!list.length) return;
    if (!auto && remaining !== null && list.length > remaining) {
      const ok = await askConfirm({
        title: remaining === 0 ? "今天的 AI 次數用完了" : "今天的 AI 次數不夠",
        message:
          remaining === 0
            ? "今天的 AI 評分次數已經用完，明天會重置。你還是可以用「自己打分」繼續批改。"
            : `今天只剩 ${remaining} 次 AI 評分，這次要評 ${list.length} 位，會先評前 ${remaining} 位，剩下的要等明天或自己打分。要繼續嗎？`,
        okText: remaining === 0 ? "知道了" : "繼續",
      });
      if (!ok || remaining === 0) return;
    }
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
      todo: list.filter((s) => !s.status && hasTurnedIn(s) && !needsTeacher(s)).length,
      manual: list.filter((s) => !!needsTeacher(s)).length,
      review: list.filter((s) => s.status === "ai_suggested" || s.status === "teacher_edited").length,
      done: list.filter((s) => s.status === "confirmed").length,
      failed: list.filter((s) => failures[s.id]).length,
      resubmitted: list.filter(isResubmitted).length,
      // 三色分流：只算「AI 建議但老師還沒動過」的（ai_suggested）。老師已經改過/確認過的
      // 不用再標risk——那已經是老師自己的判斷了，不是要老師去看的東西
      greenCount: list.filter((s) => s.status === "ai_suggested" && s.risk_level === "green").length,
      yellowCount: list.filter((s) => s.status === "ai_suggested" && s.risk_level === "yellow").length,
      redCount: list.filter((s) => s.status === "ai_suggested" && s.risk_level === "red").length,
    }),
    [list, failures]
  );
  const ungraded = list.filter((s) => !s.status && !failures[s.id] && hasTurnedIn(s) && !needsTeacher(s));
  const failedList = list.filter((s) => failures[s.id]);

  const visible = list.filter((s) => {
    if (filter === "todo") return !s.status && hasTurnedIn(s) && !needsTeacher(s);
    if (filter === "manual") return !!needsTeacher(s);
    if (filter === "review") return s.status === "ai_suggested" || s.status === "teacher_edited";
    if (filter === "done") return s.status === "confirmed";
    if (filter === "failed") return !!failures[s.id];
    if (filter === "resubmitted") return isResubmitted(s);
    return true;
  }).filter((s) => !nameQuery.trim() || s.student_name.toLowerCase().includes(nameQuery.trim().toLowerCase()));

  // v1.21.0 一鍵確認全部綠燈：只動「AI 建議、老師還沒碰、三色是綠」的，逐位送出，跟老師一位一位按「完成批改」同一條 API
  async function confirmGreens() {
    const greens = list.filter((s) => s.status === "ai_suggested" && s.risk_level === "green" && s.locked !== 1);
    if (!greens.length) return;
    const lines = greens.slice(0, 8).map((s) => `${s.student_name}　${s.final_score ?? s.ai_score} 分`);
    const more = greens.length > 8 ? `…另外還有 ${greens.length - 8} 位` : "";
    const ok = await askConfirm({
      title: `確認這 ${greens.length} 位的分數嗎？`,
      message: ["AI 給的分數和評語都會照原樣確認，之後仍可解鎖修改。", "", ...lines, more].join("\n"),
      okText: `確認 ${greens.length} 位`,
    });
    if (!ok) return;
    setConfirmMsg("");
    let done = 0;
    const failed: string[] = [];
    setConfirming({ done: 0, total: greens.length });
    for (const s of greens) {
      try {
        await api.updateGrade(s.id, {
          finalScore: Number(s.final_score ?? s.ai_score),
          finalFeedback: s.final_feedback ?? s.ai_feedback ?? "",
          confirm: true,
        });
      } catch {
        failed.push(s.student_name);
      }
      done += 1;
      setConfirming({ done, total: greens.length });
    }
    setConfirming(null);
    await refreshSubmissions();
    setConfirmMsg(
      failed.length
        ? `已確認 ${greens.length - failed.length} 位，有 ${failed.length} 位沒成功（${failed.join("、")}），可以個別再按「完成批改」。`
        : `已確認 ${greens.length} 位。`
    );
  }

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

  // Alt＋←／→ 上一位／下一位（用 Alt 是為了不搶輸入框裡游標移動的方向鍵）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const cards = visible.map((s) => cardRefs.current[s.id]).filter(Boolean) as HTMLDivElement[];
      if (!cards.length) return;
      const mid = window.innerHeight / 3;
      let idx = cards.findIndex((el) => el.getBoundingClientRect().bottom > mid);
      if (idx < 0) idx = cards.length - 1;
      const target = visible[Math.min(cards.length - 1, Math.max(0, idx + (e.key === "ArrowRight" ? 1 : -1)))];
      e.preventDefault();
      goTo(target?.id, true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const maxPoints = rubric?.maxPoints ?? rubric?.max_points ?? assignment?.maxPoints ?? 100;
  // v1.18.0 同學作答雷同提醒：對照標準答案的作業大家答對本來就會很像，不比
  const similar = useMemo(
    () => (rubric && rubric.mode !== "answer_key" && submissions ? findSimilar(submissions) : new Map<string, SimilarMatch>()),
    [rubric, submissions]
  );
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
    ...(counts.manual ? [{ key: "manual" as Filter, label: "要你自己批", n: counts.manual }] : []),
    ...(counts.failed ? [{ key: "failed" as Filter, label: "評分失敗", n: counts.failed }] : []),
    ...(counts.resubmitted ? [{ key: "resubmitted" as Filter, label: "學生重交", n: counts.resubmitted }] : []),
  ];

  return (
    <div>
      <Stepper current={3} />
      <SafeLink to={`/courses/${courseId}`} state={{ courseName: assignment?.courseName }} className="back-link">
        ← 上一步：換一份作業
      </SafeLink>

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
          <SafeLink to={setupPath} state={assignment} className="link-btn">
            修改評分標準
          </SafeLink>
        </div>
      )}

      <p className="trust-note">
        {writeback.canWriteBack
          ? "AI 給的分數和評語只是草稿，要看過、按「完成批改」才算數；只有你確認過的分數才能送回 Classroom。"
          : "AI 給的分數和評語只是草稿，不會寫回 Google Classroom；要看過、按「完成批改」才算數。"}
      </p>

      {(assignment?.teacherCount ?? 1) > 1 && (
        <p className="trust-note">
          這門課有 {assignment?.teacherCount} 位老師，分數和評語是大家共用的：你改的其他老師看得到，別人改的你重新整理也會看到。
        </p>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="toolbar card">
        <div className="progress-wrap" aria-label={`已完成 ${counts.done} 位，共 ${gradableCount} 位有交作業`}>
          <div className="progress-label">
            已完成 <strong>{counts.done}</strong> ／ {gradableCount} 位（已交作業的人數）
          </div>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          {counts.review > 0 && (
            <div className="risk-summary" aria-label="AI 評分結果的三色分流">
              <span className="risk-chip risk-green">🟢 {counts.greenCount} 可直接確認</span>
              {counts.greenCount > 0 && (
                <button className="small" onClick={confirmGreens} disabled={!!confirming || !!batch}>
                  {confirming ? `確認中 ${confirming.done}／${confirming.total}…` : `一鍵確認 ${counts.greenCount} 位`}
                </button>
              )}
              <span className="risk-chip risk-yellow">🟡 {counts.yellowCount} 建議看一下</span>
              <span className="risk-chip risk-red">🔴 {counts.redCount} 需要確認</span>
            </div>
          )}
        </div>
        <div className="row toolbar-actions">
          {ungraded.length > 0 && (
            <button
              onClick={() => gradeMany(ungraded)}
              disabled={!!batch || !rubric || remaining === 0}
              title={remaining === 0 ? "今天的 AI 評分次數已經用完，明天會重置" : undefined}
            >
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
          {counts.review + counts.done > 0 && (
            <button className="secondary" onClick={copyAllGrades}>
              {copiedAll ? "已複製，貼到 Classroom 成績簿吧" : "複製全班分數"}
            </button>
          )}
        </div>
        {remaining !== null && (
          <p className={`small-text ${remaining === 0 ? "warn-text" : "muted"}`}>
            {remaining === 0
              ? "今天的 AI 評分次數已經用完，明天會重置。還是可以用每位學生卡片上的「自己打分」繼續批改。"
              : `今天還可以讓 AI 評 ${remaining} 份（每位老師每天都有上限，避免一個人把大家共用的 AI 額度用光）。`}
          </p>
        )}
        {confirmMsg && (
          <p className="small-text muted" role="status">
            {confirmMsg}
          </p>
        )}
        {batch && (
          <div className="batch-note" role="status">
            AI 正在自動評第 {Math.min(batch.done + 1, batch.total)}／{batch.total} 位，評好的會一位一位出現。全部大約要 1～3
            分鐘，可以先切到別的分頁，但不要關掉這一頁。
          </div>
        )}
      </div>

      {courseWorkId && list.length > 0 && (
        <WritebackPanel
          rows={list}
          canWriteBack={writeback.canWriteBack}
          canWrite={writeback.canWrite}
          courseWorkId={courseWorkId}
          onPushed={refreshSubmissions}
        />
      )}
      {courseWorkId && <InsightsPanel courseWorkId={courseWorkId} refreshKey={insightsKey} />}

      {counts.resubmitted > 0 && filter !== "resubmitted" && (
        <div className="warn-text error-box" role="status">
          <span>有 {counts.resubmitted} 位學生在你評分之後又重新交了作業，分數是針對舊版本的。</span>
          <button className="secondary small" onClick={() => setFilter("resubmitted")}>
            只看這幾位
          </button>
        </div>
      )}

      {allDone && (
        <div className="done-banner">
          <img src="/illust/done.webp" alt="" width={120} height={120} />
          <div>
            <strong>全班都批改完了！</strong>
            <p>
              {writeback.canWriteBack
                ? "按上面「送到 Classroom」把分數送回去，評語用每張卡片的「複製分數與評語」貼到 Classroom。"
                : "按每張卡片的「複製分數與評語」貼回 Classroom，或下載 Excel 成績表對照登記。"}
            </p>
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

      {list.length > 5 && (
        <input
          type="search"
          className="name-search"
          placeholder="輸入學生姓名快速找"
          aria-label="搜尋學生姓名"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
        />
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
          needsTeacher={needsTeacher(s)}
          similar={similar.get(s.id)}
          canWriteBack={writeback.canWriteBack}
          position={`${i + 1}／${visible.length}`}
          onPrev={i > 0 ? () => goTo(visible[i - 1].id) : undefined}
          onNext={i < visible.length - 1 ? () => goTo(visible[i + 1].id) : undefined}
          onAiGrade={(force) => gradeOne(s, force)}
          onSaved={async () => {
            // 老師自己打過分就不再算「評分失敗」，免得按「只重評失敗的」時 AI 把老師的分數蓋掉
            clearFailure(s.id);
            await refreshSubmissions();
          }}
          onConfirmed={() => goNextUnfinished(s.id)}
        />
      ))}
    </div>
  );
}
