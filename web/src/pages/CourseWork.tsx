import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";

interface Work {
  id: string;
  title: string;
  maxPoints?: number;
  dueDate?: { year: number; month: number; day: number };
  dueTime?: { hours?: number; minutes?: number };
  creationTime?: string;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

// Classroom 的截止時間是 UTC，換成台灣時間顯示
function dueOf(w: Work): Date | null {
  if (!w.dueDate) return null;
  const { year, month, day } = w.dueDate;
  return new Date(Date.UTC(year, month - 1, day, w.dueTime?.hours ?? 23, w.dueTime?.minutes ?? 59));
}

// 用 getHours()/getDate() 這類本地時間函式，顯示出來的其實是「瀏覽器系統時區」，
// 只有系統時區剛好是台灣時才會恰好正確——直接把UTC時間手動平移8小時再用getUTC*讀，
// 不管老師的電腦/手機設定在哪個時區，顯示的永遠是台灣時間
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatDue(d: Date): string {
  const t = new Date(d.getTime() + TAIPEI_OFFSET_MS);
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WEEKDAYS[t.getUTCDay()]}）${hh}:${mm} 截止`;
}

// 截止日最近的排前面（包含剛過期的），沒設截止日的依建立時間排在最後
function sortWorks(list: Work[]): Work[] {
  const now = Date.now();
  return [...list].sort((a, b) => {
    const da = dueOf(a);
    const db = dueOf(b);
    if (da && db) return Math.abs(da.getTime() - now) - Math.abs(db.getTime() - now);
    if (da) return -1;
    if (db) return 1;
    return (b.creationTime ?? "").localeCompare(a.creationTime ?? "");
  });
}

export default function CourseWork() {
  const { courseId } = useParams();
  const location = useLocation();
  const state = location.state as { courseName?: string; teacherCount?: number } | null;
  const courseName = state?.courseName;
  const [list, setList] = useState<Work[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    if (!courseId) return;
    setError("");
    setList(null);
    api
      .courseWork(courseId)
      .then((r) => setList(sortWorks(r.courseWork)))
      .catch((e) => setError(e.message));
  }, [courseId, reloadKey]);

  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((w) => !q || w.title.toLowerCase().includes(q));

  return (
    <div>
      <Stepper current={1} />
      <Link to="/" className="back-link">
        ← 上一步：換一門課
      </Link>
      <div className="page-head">
        <div className="eyebrow">第 2 步</div>
        <h1 className="page-title">要改哪一份作業？</h1>
        {courseName && <p className="page-sub">{courseName}</p>}
      </div>

      {error && (
        <div className="error-text error-box" role="alert">
          <span>{error}</span>
          <button className="secondary small" onClick={() => setReloadKey((k) => k + 1)}>
            再試一次
          </button>
        </div>
      )}
      {!error && !list && <p className="muted">正在讀取作業…</p>}
      {list && list.length > 6 && (
        <input
          type="search"
          className="search-input"
          placeholder="搜尋作業名稱"
          aria-label="搜尋作業"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {list?.length === 0 && (
        <div className="empty-state">
          <img src="/illust/empty.webp" alt="" width={140} height={140} />
          <p>這門課還沒有已發布的作業。先到 Google Classroom 發布一份作業，再回來這裡。</p>
        </div>
      )}

      <div className="pick-list">
        {shown.map((w) => {
          const due = dueOf(w);
          return (
            <button
              key={w.id}
              className="pick-card"
              onClick={() =>
                navigate(`/courses/${courseId}/coursework/${w.id}`, {
                  state: { title: w.title, maxPoints: w.maxPoints, courseName, teacherCount: state?.teacherCount },
                })
              }
            >
              <span className="pick-icon doc" aria-hidden="true">
                📝
              </span>
              <span className="pick-body">
                <strong>{w.title}</strong>
                <span className="muted">
                  {due ? formatDue(due) : "沒有設定截止日"}
                  {w.maxPoints != null && `｜滿分 ${w.maxPoints}`}
                </span>
              </span>
              <span className="pick-arrow" aria-hidden="true">
                ›
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
