import { useEffect, useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { api, ApiError, AUTH_LOST_EVENT } from "./api";
import SafeLink from "./components/SafeLink";
import { clearPending, confirmLeave } from "./unsaved";
import Login from "./pages/Login";
import Courses from "./pages/Courses";
import CourseWork from "./pages/CourseWork";
import NewCourseWork from "./pages/NewCourseWork";
import Grading from "./pages/Grading";
import RubricSetup from "./pages/RubricSetup";

interface Teacher {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export default function App() {
  const [teacher, setTeacher] = useState<Teacher | null | undefined>(undefined);
  // 被踢回登入頁的原因（登入過期、連不上伺服器），登入頁顯示給老師看
  const [notice, setNotice] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api
      .me()
      .then((r) => setTeacher(r.teacher))
      .catch((e) => {
        if (e instanceof ApiError && e.code === "network") setNotice(e.message);
        setTeacher(null);
      });
  }, []);

  // 任何一頁發現登入過期，都統一回到登入頁並說明原因
  useEffect(() => {
    const onLost = (e: Event) => {
      clearPending();
      setNotice((e as CustomEvent<string>).detail || "登入已過期，請重新登入");
      setTeacher(null);
    };
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, onLost);
  }, []);

  if (teacher === undefined) return <div className="container muted">載入中…</div>;
  if (teacher === null)
    return (
      <>
        <Login notice={notice} />
        <VersionTag />
      </>
    );

  return (
    <>
      <header className="app-header">
        <SafeLink to="/" className="brand-link">
          <img src="/hunglun-logo.png?v=2" alt="鴻綸科技" className="header-logo" />
          <span className="brand-name">classAI</span>
        </SafeLink>
        <div className="row">
          <span className="teacher-name">{teacher.name}</span>
          <button
            className="secondary"
            onClick={async () => {
              if (!confirmLeave()) return;
              try {
                await api.logout();
              } finally {
                navigate(0);
              }
            }}
          >
            登出
          </button>
        </div>
      </header>
      <a className="powered-by" href="https://www.hunglun.com/" target="_blank" rel="noreferrer">
        <img src="/hunglun-logo.png?v=2" alt="鴻綸科技" />
        <span>由鴻綸科技提供</span>
      </a>
      <div className="container">
        <Routes>
          <Route path="/" element={<Courses />} />
          <Route path="/courses/:courseId" element={<CourseWork />} />
          <Route path="/courses/:courseId/new" element={<NewCourseWork />} />
          <Route path="/courses/:courseId/coursework/:courseWorkId/setup" element={<RubricSetup />} />
          <Route path="/courses/:courseId/coursework/:courseWorkId" element={<Grading />} />
        </Routes>
      </div>
      <VersionTag />
    </>
  );
}

// 版本號固定顯示在每頁最下方，發布後一眼就能核對線上是不是這一版
function VersionTag() {
  return <footer className="app-version">classAI v{__APP_VERSION__}</footer>;
}
