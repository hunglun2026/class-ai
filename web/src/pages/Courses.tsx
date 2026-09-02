import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

interface Course {
  id: string;
  name: string;
  section?: string;
}

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api
      .courses()
      .then((r) => setCourses(r.courses))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!courses) return <p>載入課程中…</p>;
  if (courses.length === 0) return <p>Google Classroom 沒有找到你名下的課程。</p>;

  return (
    <div>
      <h2>選一門課程</h2>
      {courses.map((c) => (
        <div key={c.id} className="card" onClick={() => navigate(`/courses/${c.id}`)}>
          <strong>{c.name}</strong>
          {c.section && <div style={{ color: "#666" }}>{c.section}</div>}
        </div>
      ))}
    </div>
  );
}
