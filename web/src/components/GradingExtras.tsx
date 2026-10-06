import { useEffect, useState } from "react";
import { api, ApiError, type InsightsState } from "../api";
import { askConfirm } from "../dialog";

/**
 * v1.18.0 批改頁的兩塊：
 * - WritebackPanel：一鍵發還（v1.22.0）：正式分數＋評語連結＋發還（只有 classAI 出的作業可以）
 * - InsightsPanel：全班學習診斷（批完 5 位以上才出現）
 */

export interface PushableRow {
  status: string | null;
  locked: number | null;
  final_score: number | null;
  ai_score: number | null;
  final_feedback?: string | null;
  ai_feedback?: string | null;
  returned_score?: number | null;
  returned_feedback?: string | null;
  returned_at?: number | null;
}

// 跟後端 lib/writeback.ts 同一個規則：已完成批改或已鎖定、有分數的才發還；分數或評語改過要再發
export function pushState(s: PushableRow): "not_ready" | "todo" | "stale" | "pushed" {
  const score = s.final_score ?? s.ai_score;
  const ready = (s.status === "confirmed" || s.locked === 1) && score != null;
  if (!ready) return "not_ready"; // 發還之後又被解鎖改分、還沒再確認的，也要等完成批改才發
  if (s.returned_at == null) return "todo";
  const feedback = s.final_feedback ?? s.ai_feedback ?? "";
  return s.returned_score === score && (s.returned_feedback ?? "") === feedback ? "pushed" : "stale";
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
  const [result, setResult] = useState<{ pushed: number; failed: { name: string; reason: string }[]; linkBlocked: boolean } | null>(null);
  const [error, setError] = useState("");
  const [needPermission, setNeedPermission] = useState(false);
  const denied = new URLSearchParams(window.location.search).get("write") === "denied";

  if (!canWriteBack) {
    return (
      <div className="card writeback-panel muted-panel">
        <p className="small-text muted">
          這份作業是在 Classroom 建的，Google 不開放外部工具寫分數，請用「複製全班分數」或 Excel 登記。
          下次在 classAI 出作業，批完就能一鍵發還給學生。
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
    const ok = await askConfirm({
      title: "發還給學生",
      message: `要把 ${todo} 位的分數和評語發還嗎？學生會馬上收到 Classroom 通知，看得到分數，點作業裡的連結就能看到評語。`,
      okText: `發還 ${todo} 位`,
    });
    if (!ok) return;
    setPushing(true);
    setError("");
    setResult(null);
    let pushed = 0;
    let linkBlocked = false;
    const failed: { name: string; reason: string }[] = [];
    try {
      // 一次最多發還 15 位，剩下的接著送；某一輪一位都沒成功就停，免得一直重試同樣的失敗
      for (let round = 0; round < 20; round++) {
        const r = await api.pushGrades(courseWorkId);
        pushed += r.pushed;
        failed.push(...r.failed);
        linkBlocked ||= r.linkBlocked;
        if (r.remaining <= 0 || r.pushed === 0) break;
      }
      setResult({ pushed, failed, linkBlocked });
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
        <strong>發還給學生</strong>
        <span className="muted">
          ｜已發還 {pushedCount} 位{staleCount > 0 && `、${staleCount} 位發還後又改過`}
          {notReady > 0 && `、${notReady} 位還沒完成批改（完成後才能發還）`}
        </span>
      </p>
      <p className="small-text muted">
        一鍵把分數寫進 Classroom 並發還，學生作業裡會多一個「老師的評語」連結。不用再開 Classroom。
      </p>
      {denied && showPermission && (
        <p className="error-text" role="alert">
          剛剛在 Google 同意畫面沒有勾到「查看、建立及編輯課程作業」，所以還沒辦法發還。
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
            {result.pushed > 0 ? `已發還 ${result.pushed} 位。` : "沒有需要發還的。"}
            {result.failed.length > 0 && `有 ${result.failed.length} 位沒發還成功：`}
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
          {result.linkBlocked && (
            <p className="warn-text">
              分數已發還，但 Google 不讓 classAI 把評語連結放進學生的作業。評語請用每位的「複製分數與評語」貼到 Classroom 私人留言。
            </p>
          )}
        </div>
      )}
      <div className="form-footer">
        {showPermission ? (
          <>
            <button onClick={askPermission}>允許 classAI 發還分數到 Classroom</button>
            <span className="small-text muted">會跳到 Google 同意畫面，多允許「查看、建立及編輯課程作業」一項</span>
          </>
        ) : (
          <button onClick={push} disabled={pushing || todo === 0}>
            {pushing ? "發還中…" : todo > 0 ? `把已確認的 ${todo} 位發還給學生` : "都發還了"}
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
