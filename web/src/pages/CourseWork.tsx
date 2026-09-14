import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

interface Work {
  id: string;
  title: string;
  maxPoints?: number;
}

export default function CourseWork() {
  const { courseId } = useParams();
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

  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!list) return <p>載入作業中…</p>;
  if (list.length === 0) return <p>這門課還沒有已發布的作業。</p>;

  return (
    <div>
      <h2>選一份作業</h2>
      {list.map((w) => (
        <div
          key={w.id}
          className="card clickable"
          onClick={() =>
            navigate(`/courses/${courseId}/coursework/${w.id}`, {
              state: { title: w.title, maxPoints: w.maxPoints },
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
