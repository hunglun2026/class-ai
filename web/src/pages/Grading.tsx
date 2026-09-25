import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";
import SafeLink from "../components/SafeLink";
import { setPending } from "../unsaved";
import { MODE_LABEL, type AssignmentState, type Mode } from "./RubricSetup";
import { InsightsPanel, pushState, WritebackPanel } from "../components/GradingExtras";
import { findSimilar, type SimilarMatch } from "../similarity";

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
  risk_level: "green" | "yellow" | "red" | null;
  attachments_json: string | null;
  turned_in_at: number | null; // 學生最後一次繳交時間（unix 秒）
  grade_updated_at: number | null; // 分數最後一次變動時間
  autograde_error: string | null; // 背景自動預批時 AI 評不了的原因（v1.17.0），老師要自己批
  pushed_score: number | null; // 已送到 Classroom 的草稿分數（v1.18.0）
  pushed_at: number | null;
}

// AI 評不了、要老師自己批的（老師已經打過分就不算）
function needsTeacher(s: Submission): string | undefined {
  return s.autograde_error && (!s.status || s.status === "ai_suggested") ? s.autograde_error : undefined;
}

// 學生在老師評分之後又重交：分數是針對舊版本的，要提醒老師重看
function isResubmitted(s: Submission): boolean {
  return !!s.status && s.turned_in_at != null && s.grade_updated_at != null && s.turned_in_at > s.grade_updated_at;
}

interface AttachmentLink {
  name: string;
  href: string | null; // null＝網址不安全或沒有，只顯示名稱不做成連結
}

// 只放行 http/https：學生交的連結網址是學生自己填的，javascript: 之類做成連結，老師一點就會執行（XSS）
function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function parseAttachments(raw: string | null): AttachmentLink[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map((a: { name?: string; url?: string; driveFileId?: string }) => ({
      name: a.name || "未命名檔案",
      // 雲端硬碟檔案：同步時存的原檔連結；舊資料沒存連結就用檔案 ID 組
      href:
        safeHttpUrl(a.url) ??
        (a.driveFileId ? `https://drive.google.com/file/d/${encodeURIComponent(a.driveFileId)}/view` : null),
    }));
  } catch {
    return [];
  }
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

type Filter = "all" | "todo" | "review" | "done" | "failed" | "resubmitted" | "manual";

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
  const [copiedAll, setCopiedAll] = useState(false);
  // v1.18.0：這份作業能不能把分數送回 Classroom（classAI 出的才行）、老師有沒有給寫入權限
  const [writeback, setWriteback] = useState<{ canWriteBack: boolean; canWrite: boolean }>({ canWriteBack: false, canWrite: false });
  const [insightsKey, setInsightsKey] = useState(0);
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
      const ok = window.confirm(
        remaining === 0
          ? "今天的 AI 評分次數已經用完，明天會重置。你還是可以用「自己打分」繼續批改。"
          : `今天只剩 ${remaining} 次 AI 評分，這次要評 ${list.length} 位，會先評前 ${remaining} 位，剩下的要等明天或自己打分。要繼續嗎？`
      );
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
  // v1.18.0：送回 Classroom 的狀態（只有 classAI 出的作業才顯示）
  const push = canWriteBack ? pushState(submission) : "not_ready";
  const pushBadge =
    push === "pushed" ? (
      <span className="badge pushed">已送 Classroom</span>
    ) : push === "stale" ? (
      <span className="badge push-stale" title="送出後你又改了分數">Classroom 上是 {submission.pushed_score} 分，要再送</span>
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
            {locked ? "這筆已確認鎖定，AI 重評與直接編輯都要先解鎖" : "電腦上可以按 Ctrl＋Enter 完成並跳到下一位"}
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
