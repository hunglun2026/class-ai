import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type InboxItem } from "../api";
import Stepper from "../components/Stepper";

interface Course {
  id: string;
  name: string;
  section?: string;
  teacherCount?: number;
}

function agoText(sec: number | null): string {
  if (!sec) return "";
  const min = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
  if (min < 1) return "剛剛更新";
  if (min < 60) return `${min} 分鐘前更新`;
  return `${Math.round(min / 60)} 小時前更新`;
}

// 首頁「等你確認」（v1.17.0）：classAI 在背景已經幫忙批好的作業，點進去直接確認。
// 讀不到或沒有東西就整塊不顯示，不擋原本「選課→選作業」的流程
function InboxPanel({ onRelogin }: { onRelogin: () => void }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .inbox()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);

  if (!items.length) return null;
  const authLost = items.some((i) => i.lastError === "auth_expired");

  return (
    <section className="inbox-panel" aria-label="等你確認">
      <h2 className="inbox-title">等你確認</h2>
      <p className="muted inbox-sub">學生交了作業，classAI 會自己去 Classroom 拿來先評好，你只要看過、按確認。</p>
      {authLost && (
        <div className="error-text error-box" role="alert">
          <span>Google 授權過期了，classAI 暫時沒辦法幫你先批，請重新登入一次</span>
          <button className="secondary small" onClick={onRelogin}>
            重新登入
          </button>
        </div>
      )}
      <div className="pick-list">
        {items.map((it) => (
          <button
            key={it.courseWorkId}
            className="pick-card"
            onClick={() =>
              navigate(`/courses/${it.courseId}/coursework/${it.courseWorkId}`, {
                state: { title: it.title, maxPoints: it.maxPoints ?? undefined, courseName: it.courseName },
              })
            }
          >
            <span className="pick-icon doc" aria-hidden="true">
              ✅
            </span>
            <span className="pick-body">
              <strong>{it.title}</strong>
              <span className="muted">
                {it.courseName}
                {it.autoSyncedAt ? `｜${agoText(it.autoSyncedAt)}` : ""}
              </span>
              <span className="risk-summary">
                {it.green > 0 && <span className="badge risk-green">🟢 {it.green} 位可直接確認</span>}
                {it.yellow > 0 && <span className="badge risk-yellow">🟡 {it.yellow} 位建議看一下</span>}
                {it.red > 0 && <span className="badge risk-red">🔴 {it.red} 位需要確認</span>}
                {it.needsTeacher > 0 && <span className="badge failed">✋ {it.needsTeacher} 位要你自己批</span>}
                {it.resubmitted > 0 && <span className="badge review">🔄 {it.resubmitted} 位學生重交</span>}
              </span>
            </span>
            <span className="pick-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

const INTRO_DISMISSED_KEY = "classai_intro_dismissed";
const SEARCH_THRESHOLD = 6;

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState("");
  const [authExpired, setAuthExpired] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    try {
      setShowIntro(localStorage.getItem(INTRO_DISMISSED_KEY) !== "1");
    } catch {
      setShowIntro(true);
    }
  }, []);

  function dismissIntro() {
    setShowIntro(false);
    try {
      localStorage.setItem(INTRO_DISMISSED_KEY, "1");
    } catch {
      /* 私人瀏覽模式可能擋掉localStorage，忽略即可，下次重整理還是會再顯示一次 */
    }
  }

  useEffect(() => {
    setError("");
    setCourses(null);
    api
      .courses()
      .then((r) => setCourses(r.courses))
      .catch((e) => {
        setError(e.message);
        setAuthExpired(e instanceof ApiError && e.code === "auth_expired");
      });
  }, [reloadKey]);

  async function switchAccount() {
    try {
      await api.logout();
    } finally {
      window.location.href = api.loginUrl();
    }
  }

  const q = query.trim().toLowerCase();
  const shown = (courses ?? []).filter(
    (c) => !q || c.name.toLowerCase().includes(q) || (c.section ?? "").toLowerCase().includes(q)
  );

  return (
    <div>
      <Stepper current={0} />

      {showIntro && (
        <div className="intro-card">
          <button className="intro-close" onClick={dismissIntro} aria-label="關閉說明">
            ✕
          </button>
          <h3>四個步驟改完一份作業</h3>
          <ol className="intro-steps">
            <li>選一門課</li>
            <li>選一份作業</li>
            <li>告訴 AI 怎麼評分（有作文、學習單等範本，按一下就帶入）</li>
            <li>AI 先幫全班評一輪，你看過、修改，再按「完成批改」</li>
          </ol>
          <p className="intro-note">分數不會自動送回 Classroom，改好後用「複製」或下載 Excel 自己登記。</p>
        </div>
      )}

      <InboxPanel onRelogin={switchAccount} />

      <div className="page-head">
        <div className="eyebrow">第 1 步</div>
        <h1 className="page-title">要改哪一門課的作業？</h1>
      </div>

      {error && (
        <div className="error-text error-box" role="alert">
          <span>{error}</span>
          {authExpired ? (
            <button className="secondary small" onClick={switchAccount}>
              重新登入
            </button>
          ) : (
            <button className="secondary small" onClick={() => setReloadKey((k) => k + 1)}>
              再試一次
            </button>
          )}
        </div>
      )}
      {!error && !courses && <p className="muted">正在讀取你的 Classroom 課程…</p>}

      {courses && courses.length > SEARCH_THRESHOLD && (
        <input
          type="search"
          className="search-input"
          placeholder="搜尋課程或班級名稱"
          aria-label="搜尋課程"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {courses?.length === 0 && (
        <div className="empty-state">
          <img src="/illust/empty.webp" alt="" width={140} height={140} />
          <p>
            <strong>找不到課程</strong>
            <br />
            可能沒有用開課的那個 Google 帳號登入。請改用在 Google Classroom <strong>開課的那個帳號</strong>；
            如果這個帳號還沒開過課，先到 classroom.google.com 建一門。
          </p>
          <button onClick={switchAccount}>換一個 Google 帳號登入</button>
        </div>
      )}
      {courses && courses.length > 0 && shown.length === 0 && <p className="muted">沒有符合「{query}」的課程。</p>}

      <div className="pick-list">
        {shown.map((c) => (
          <button
            key={c.id}
            className="pick-card"
            onClick={() => navigate(`/courses/${c.id}`, { state: { courseName: c.name, teacherCount: c.teacherCount } })}
          >
            <span className="pick-icon" aria-hidden="true">
              {c.name.slice(0, 1)}
            </span>
            <span className="pick-body">
              <strong>{c.name}</strong>
              <span className="muted">
                {c.section}
                {(c.teacherCount ?? 1) > 1 && `${c.section ? "｜" : ""}${c.teacherCount} 位老師共用`}
              </span>
            </span>
            <span className="pick-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
