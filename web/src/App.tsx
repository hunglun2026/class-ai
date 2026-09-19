import { useEffect, useState } from "react";
import { Routes, Route, Link, useNavigate } from "react-router-dom";
import { api } from "./api";
import Login from "./pages/Login";
import Courses from "./pages/Courses";
import CourseWork from "./pages/CourseWork";
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
  const navigate = useNavigate();

  useEffect(() => {
    api.me().then((r) => setTeacher(r.teacher)).catch(() => setTeacher(null));
  }, []);

  if (teacher === undefined) return <div className="container muted">載入中…</div>;
  if (teacher === null)
    return (
      <>
        <Login />
        <VersionTag />
      </>
    );

  return (
    <>
      <header className="app-header">
        <Link to="/" className="brand-link">
          <img src="/hunglun-logo.png?v=2" alt="鴻綸科技" className="header-logo" />
          <span className="brand-name">classAI</span>
        </Link>
        <div className="row">
          <span className="teacher-name">{teacher.name}</span>
          <button
            className="secondary"
            onClick={async () => {
              await api.logout();
              navigate(0);
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
