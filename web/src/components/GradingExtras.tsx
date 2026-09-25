import { useEffect, useState } from "react";
import { api, ApiError, type InsightsState } from "../api";

/**
 * v1.18.0 批改頁的兩塊：
 * - WritebackPanel：把老師確認過的分數送回 Classroom 草稿分數（只有 classAI 出的作業可以）
 * - InsightsPanel：全班學習診斷（批完 5 位以上才出現）
 */

export interface PushableRow {
  status: string | null;
  locked: number | null;
  final_score: number | null;
  ai_score: number | null;
  pushed_score?: number | null;
}

// 跟後端 lib/writeback.ts 同一個規則：已完成批改或已鎖定、有分數的才送
export function pushState(s: PushableRow): "not_ready" | "todo" | "stale" | "pushed" {
  const score = s.final_score ?? s.ai_score;
  const ready = (s.status === "confirmed" || s.locked === 1) && score != null;
  if (!ready) return "not_ready"; // 送過之後又被解鎖改分、還沒再確認的，也要等完成批改才送
  if (s.pushed_score == null) return "todo";
  return s.pushed_score === score ? "pushed" : "stale";
}

export function WritebackPanel({
  rows,
  canWriteBack,
  canWrite,
  courseWorkId,
  onPushed,
}: {
  rows: PushableRow[];
  canWriteBack: boolean;
  canWrite: boolean;
  courseWorkId: string;
  onPushed: () => Promise<void>;
}) {
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ pushed: number; failed: { name: string; reason: string }[] } | null>(null);
  const [error, setError] = useState("");
  const [needPermission, setNeedPermission] = useState(false);
  const denied = new URLSearchParams(window.location.search).get("write") === "denied";

  if (!canWriteBack) {
    return (
      <div className="card writeback-panel muted-panel">
        <p className="small-text muted">
          這份作業是在 Classroom 建的，Google 不開放外部工具寫分數，請用「複製全班分數」或 Excel 登記。
          下次在 classAI 出作業，批完就能一鍵送回 Classroom。
        </p>
      </div>
    );
  }

  const states = rows.map(pushState);
  const todo = states.filter((x) => x === "todo" || x === "stale").length;
  const pushedCount = states.filter((x) => x === "pushed").length;
  const staleCount = states.filter((x) => x === "stale").length;
  const notReady = states.filter((x) => x === "not_ready").length;

  const askPermission = () => {
    window.location.href = api.upgradeUrl(window.location.pathname);
  };

  async function push() {
    setPushing(true);
    setError("");
    setResult(null);
    let pushed = 0;
    const failed: { name: string; reason: string }[] = [];
    try {
      // 一次最多送 40 位，剩下的接著送；某一輪一位都沒送成功就停，免得一直重試同樣的失敗
      for (let round = 0; round < 10; round++) {
        const r = await api.pushGrades(courseWorkId);
        pushed += r.pushed;
        failed.push(...r.failed);
        if (r.remaining <= 0 || r.pushed === 0) break;
      }
      setResult({ pushed, failed });
    } catch (e) {
      if (e instanceof ApiError && e.code === "need_write_scope") setNeedPermission(true);
      setError((e as Error).message);
    } finally {
      await onPushed();
      setPushing(false);
    }
  }

  const showPermission = !canWrite || needPermission;
  return (
    <div className="card writeback-panel">
      <p>
        <strong>送回 Classroom</strong>
        <span className="muted">
          ｜已送 {pushedCount} 位{staleCount > 0 && `、${staleCount} 位送出後又改過分數`}
          {notReady > 0 && `、${notReady} 位還沒完成批改（完成後才能送）`}
        </span>
      </p>
      <p className="small-text muted">
        送的是 Classroom 的「草稿分數」，學生看不到；到 Classroom 確認後按「發還」才算數。評語 Google 沒開放寫入，請用每位的「複製分數與評語」。
      </p>
      {denied && showPermission && (
        <p className="error-text" role="alert">
          剛剛在 Google 同意畫面沒有勾到「查看、建立及編輯課程作業」，所以還送不回去。
        </p>
      )}
      {error && !showPermission && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p className={result.failed.length ? "warn-text" : "ok-text"}>
            {result.pushed > 0 ? `已送 ${result.pushed} 位的分數到 Classroom。` : "沒有需要送的分數。"}
            {result.failed.length > 0 && `有 ${result.failed.length} 位沒送成功：`}
          </p>
          {result.failed.length > 0 && (
            <ul className="push-fail-list">
              {result.failed.map((f, i) => (
                <li key={i}>
                  {f.name}：{f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="form-footer">
        {showPermission ? (
          <>
            <button onClick={askPermission}>允許 classAI 送分數到 Classroom</button>
            <span className="small-text muted">會跳到 Google 同意畫面，多允許「查看、建立及編輯課程作業」一項</span>
          </>
        ) : (
          <button onClick={push} disabled={pushing || todo === 0}>
            {pushing ? "送出中…" : todo > 0 ? `把已確認的 ${todo} 位分數送到 Classroom` : "都送過了"}
          </button>
        )}
      </div>
    </div>
  );
}

export function InsightsPanel({ courseWorkId, refreshKey }: { courseWorkId: string; refreshKey: number }) {
  const [state, setState] = useState<InsightsState | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getInsights(courseWorkId)
      .then(setState)
      .catch(() => setState(null)); // 讀不到就不顯示，不擋老師批改
  }, [courseWorkId, refreshKey]);

  if (!state || state.gradedCount < state.minGraded) return null;

  async function build() {
    setBuilding(true);
    setError("");
    try {
      const r = await api.buildInsights(courseWorkId);
      setState((s) => (s ? { ...s, insights: r.insights, createdAt: r.createdAt, stale: false } : s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  const ins = state.insights;
  return (
    <div className="card insights-panel">
      <h2>全班常見問題</h2>
      {!ins && (
        <p className="small-text muted">
          已經批好 {state.gradedCount} 位。AI 可以讀全班的評語，整理出大家共同卡關的地方，還有下次上課可以怎麼補（用 1 次 AI 次數；學生姓名不會送給 AI）。
        </p>
      )}
      {ins && (
        <>
          {ins.summary && <p>{ins.summary}</p>}
          {ins.strengths && <p className="small-text">👍 做得好的：{ins.strengths}</p>}
          {ins.issues.length === 0 && <p className="muted">沒有找到很多人都有的共同問題。</p>}
          {ins.issues.map((it, i) => (
            <div key={i} className="insights-issue">
              <strong>
                {i + 1}. {it.title}（{it.students.length} 位）
              </strong>
              <p>{it.detail}</p>
              <p className="insights-names">{it.students.join("、")}</p>
              <p className="insights-tip">💡 {it.suggestion}</p>
            </div>
          ))}
          <p className="small-text muted">AI 整理的只是參考，以你自己看學生作業的判斷為準。</p>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {(!ins || state.stale) && (
        <div className="form-footer">
          <button className={ins ? "secondary" : undefined} onClick={build} disabled={building}>
            {building ? "AI 整理中（約 10～30 秒）…" : ins ? "分數有改過，重新整理一次" : "整理全班常見問題"}
          </button>
        </div>
      )}
    </div>
  );
}
