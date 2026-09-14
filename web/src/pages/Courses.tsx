import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";

interface Course {
  id: string;
  name: string;
  section?: string;
}

const INTRO_DISMISSED_KEY = "classai_intro_dismissed";

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState("");
  const [showIntro, setShowIntro] = useState(true);
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
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <Stepper current={0} />

      {showIntro && (
        <div className="intro-card">
          <button className="intro-close" onClick={dismissIntro} aria-label="關閉">
            ✕
          </button>
          <h3>這個工具在幫你做什麼？</h3>
          <ol className="intro-steps">
            <li>選一門課、一份作業</li>
            <li>打幾句話告訴 AI 這次要怎麼評分（有預設可以直接用）</li>
            <li>AI 幫你先看過全班，給建議分數跟評語</li>
            <li>你看過覺得可以了再確認，成績還是你自己登記進 Google Classroom</li>
          </ol>
          <p className="intro-note">全程不會自動幫你把分數送出去，AI 給的都只是草稿，你隨時可以修改。</p>
        </div>
      )}

      <h2>選一門課程</h2>
      {error && <p className="error-text">{error}</p>}
      {!error && !courses && <p>載入課程中…</p>}
      {courses?.length === 0 && (
        <p className="empty-hint">
          Google Classroom 沒有找到你名下的課程，先確認這個 Google 帳號在 Classroom 裡有開課，
          或是還沒開課的話先去 classroom.google.com 建一門。
        </p>
      )}
      {courses?.map((c) => (
        <div
          key={c.id}
          className="card clickable"
          onClick={() => navigate(`/courses/${c.id}`, { state: { courseName: c.name } })}
        >
          <strong>{c.name}</strong>
          {c.section && <div style={{ color: "#666" }}>{c.section}</div>}
        </div>
      ))}
    </div>
  );
}
