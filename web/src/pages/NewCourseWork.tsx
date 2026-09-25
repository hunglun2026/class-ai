import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import Stepper from "../components/Stepper";

/**
 * v1.18.0 在 classAI 出作業：作業建在老師自己的 Classroom 課程裡（學生照常在 Classroom 看到、繳交），
 * 差別是 classAI 建的作業，老師確認完的分數可以一鍵送回 Classroom 草稿分數。
 * Google 只讓建立作業的那個工具寫分數，所以要從這裡出作業才送得回去。
 */

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
function taipeiToday(): string {
  return new Date(Date.now() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

export default function NewCourseWork() {
  const { courseId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const courseName = (location.state as { courseName?: string } | null)?.courseName;
  const denied = params.get("write") === "denied";

  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [maxPoints, setMaxPoints] = useState("100");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("23:59");
  const [publish, setPublish] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .me()
      .then((r) => setCanWrite(!!r.teacher?.canWrite))
      .catch((e) => setError(e.message));
  }, []);

  const askPermission = () => {
    window.location.href = api.upgradeUrl(`/courses/${courseId}/new`);
  };

  const points = Number(maxPoints);
  const pointsOk = Number.isInteger(points) && points >= 1 && points <= 1000;
  const dueOk = !dueDate || new Date(`${dueDate}T${dueTime || "23:59"}:00+08:00`).getTime() > Date.now();
  const canSubmit = title.trim().length > 0 && pointsOk && dueOk && !saving;

  const submit = async () => {
    if (!courseId || !canSubmit) return;
    setSaving(true);
    setError("");
    try {
      const { courseWork } = await api.createCourseWork(courseId, {
        title: title.trim(),
        description: description.trim() || undefined,
        maxPoints: points,
        publish,
        due: dueDate ? { date: dueDate, time: dueTime || undefined } : undefined,
      });
      navigate(`/courses/${courseId}/coursework/${courseWork.id}/setup`, {
        replace: true,
        state: { title: courseWork.title, maxPoints: courseWork.maxPoints ?? points, courseName },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "need_write_scope") setCanWrite(false);
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div>
      <Stepper current={1} />
      <Link to={`/courses/${courseId}`} state={{ courseName }} className="back-link">
        ← 上一步：回作業清單
      </Link>
      <div className="page-head">
        <div className="eyebrow">第 2 步</div>
        <h1 className="page-title">在 classAI 出一份新作業</h1>
        <p className="page-sub">作業會出現在你的 Classroom 課程裡，學生照常在 Classroom 繳交。批完之後，分數可以一鍵送回 Classroom。</p>
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {canWrite === null && !error && <p className="muted">正在確認權限…</p>}

      {canWrite === false && (
        <div className="card permission-card">
          <h2 className="card-title">要多允許一項 Google 權限</h2>
          {denied && (
            <p className="error-text" role="alert">
              剛剛在 Google 同意畫面沒有勾到「查看、建立及編輯課程作業」，所以還沒辦法出作業。
            </p>
          )}
          <p>
            classAI 平常只讀取你的 Classroom。要幫你<strong>出作業</strong>、把你確認過的分數<strong>送回 Classroom</strong>，
            需要多允許一項「查看、建立及編輯課程作業」。
          </p>
          <ul className="plain-list">
            <li>送回去的是「草稿分數」，學生看不到；你在 Classroom 按「發還」才算數</li>
            <li>classAI 不會幫你發還、不會改你在 Classroom 自己出的作業</li>
            <li>之後想收回，到 Google 帳號的「第三方應用程式」移除 classAI 就好</li>
          </ul>
          <div className="form-footer">
            <button onClick={askPermission}>前往 Google 允許</button>
            <Link to={`/courses/${courseId}`} state={{ courseName }} className="btn secondary">
              先不要
            </Link>
          </div>
        </div>
      )}

      {canWrite && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="field-label block" htmlFor="nw-title">
            作業標題
          </label>
          <input id="nw-title" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：第三課閱讀心得" autoFocus />

          <label className="field-label block" htmlFor="nw-desc">
            作業說明（選填，學生在 Classroom 會看到）
          </label>
          <textarea id="nw-desc" rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />

          <label className="field-label block" htmlFor="nw-points">
            滿分
          </label>
          <input id="nw-points" type="number" min={1} max={1000} step={1} value={maxPoints} onChange={(e) => setMaxPoints(e.target.value)} className="short-input" />
          {!pointsOk && <p className="error-text hint-line">滿分請填 1～1000 的整數</p>}

          <label className="field-label block" htmlFor="nw-due">
            截止時間（選填，台灣時間）
          </label>
          <div className="due-row">
            <input id="nw-due" type="date" min={taipeiToday()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <input type="time" aria-label="截止時刻" value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={!dueDate} />
            {dueDate && (
              <button type="button" className="ghost small" onClick={() => setDueDate("")}>
                不設截止
              </button>
            )}
          </div>
          {!dueOk && <p className="error-text hint-line">截止時間已經過了，請選之後的時間</p>}

          <fieldset className="publish-choice">
            <legend className="field-label">建好之後</legend>
            <label>
              <input type="radio" name="publish" checked={publish} onChange={() => setPublish(true)} />
              <span>
                <strong>直接發布</strong>：學生馬上在 Classroom 看得到
              </span>
            </label>
            <label>
              <input type="radio" name="publish" checked={!publish} onChange={() => setPublish(false)} />
              <span>
                <strong>先存成 Classroom 草稿</strong>：想先到 Classroom 附上檔案、再自己發布
              </span>
            </label>
          </fieldset>

          <div className="form-footer">
            <button type="submit" disabled={!canSubmit}>
              {saving ? "建立中…" : "建立作業，下一步設定評分標準"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
