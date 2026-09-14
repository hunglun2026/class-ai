import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";

interface Work {
  id: string;
  title: string;
  maxPoints?: number;
}

export default function CourseWork() {
  const { courseId } = useParams();
  const location = useLocation();
  const courseName = (location.state as { courseName?: string } | null)?.courseName;
  const [list, setList] = useState<Work[] | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (!courseId) return;
    api
      .courseWork(courseId)
      .then((r) => setList(r.courseWork))
      .catch((e) => setError(e.message));
  }, [courseId]);

  return (
    <div>
      <Stepper current={1} />
      <Link to="/" className="back-link">
        ← 回課程列表
      </Link>
      <h2>{courseName ? `「${courseName}」— 選一份作業` : "選一份作業"}</h2>

      {error && <p className="error-text">{error}</p>}
      {!error && !list && <p>載入作業中…</p>}
      {list?.length === 0 && (
        <p className="empty-hint">這門課還沒有已發布的作業，先到 Google Classroom 發布一份作業再回來。</p>
      )}
      {list?.map((w) => (
        <div
          key={w.id}
          className="card clickable"
          onClick={() =>
            navigate(`/courses/${courseId}/coursework/${w.id}`, {
              state: { title: w.title, maxPoints: w.maxPoints, courseName },
            })
          }
        >
          <strong>{w.title}</strong>
          {w.maxPoints != null && <div style={{ color: "#666" }}>滿分 {w.maxPoints}</div>}
        </div>
      ))}
    </div>
  );
}
