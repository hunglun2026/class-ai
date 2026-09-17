import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import Stepper from "../components/Stepper";

interface Course {
  id: string;
  name: string;
  section?: string;
}

const INTRO_DISMISSED_KEY = "classai_intro_dismissed";
const SEARCH_THRESHOLD = 6;

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState("");
  const [authExpired, setAuthExpired] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [query, setQuery] = useState("");
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
    api
      .courses()
      .then((r) => setCourses(r.courses))
      .catch((e) => {
        setError(e.message);
        setAuthExpired(e instanceof ApiError && e.code === "auth_expired");
      });
  }, []);

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

      <div className="page-head">
        <div className="eyebrow">第 1 步</div>
        <h1 className="page-title">要改哪一門課的作業？</h1>
      </div>

      {error && (
        <p className="error-text">
          {error}
          {authExpired && (
            <>
              {" "}
              <button className="secondary small" onClick={switchAccount}>
                重新登入
              </button>
            </>
          )}
        </p>
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
            onClick={() => navigate(`/courses/${c.id}`, { state: { courseName: c.name } })}
          >
            <span className="pick-icon" aria-hidden="true">
              {c.name.slice(0, 1)}
            </span>
            <span className="pick-body">
              <strong>{c.name}</strong>
              {c.section && <span className="muted">{c.section}</span>}
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
