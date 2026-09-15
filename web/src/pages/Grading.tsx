import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";

const DEFAULT_INSTRUCTIONS =
  "請評估這份作業是否切題、論述是否清楚、有沒有明顯錯字或邏輯問題，並在評語中給出具體的改進建議。";

type Mode = "freetext" | "rubric" | "answer_key";

interface RubricItem {
  item: string;
  maxPoints: number;
  description?: string;
}

interface Submission {
  id: string;
  student_id: string;
  student_name: string;
  state: string;
  content_text: string;
  ai_score: number | null;
  ai_feedback: string | null;
  final_score: number | null;
  final_feedback: string | null;
  status: "ai_suggested" | "teacher_edited" | "confirmed" | null;
  ai_model: string | null;
}

export default function Grading() {
  const { courseId, courseWorkId } = useParams();
  const location = useLocation();
  const assignment =
    (location.state as { title?: string; maxPoints?: number; courseName?: string } | null) ?? null;
  const [rubric, setRubric] = useState<any>(null);
  const [editingRubric, setEditingRubric] = useState(false);
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!courseWorkId) return;
    api.getRubric(courseWorkId).then((r) => setRubric(r.rubric));
    // 先讀 D1 快取（不打 Classroom API），有上次同步過的資料就先顯示，不用每次進頁面都重拉
    api.listSubmissions(courseWorkId).then((r) => {
      if (r.submissions.length) setSubmissions(r.submissions);
    });
  }, [courseWorkId]);

  // 輕量刷新：只讀 D1 快取，評分/改分後更新畫面用這支
  async function refreshSubmissions() {
    if (!courseWorkId) return;
    const r = await api.listSubmissions(courseWorkId);
    setSubmissions(r.submissions);
  }

  // 重量同步：真的去打 Classroom API 拉最新繳交＋全班名冊，老師按「拉取最新繳交」才呼叫
  async function syncSubmissions() {
    if (!courseId || !courseWorkId) return;
    setBusy("pulling");
    setError("");
    try {
      const r = await api.syncSubmissions(courseId, courseWorkId);
      setSubmissions(r.submissions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function aiGradeOne(submissionId: string) {
    setBusy(submissionId);
    setError("");
    try {
      await api.aiGrade(submissionId);
      await refreshSubmissions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // 一個個排隊評分整班會很慢（30人就是等30次API），改成同時最多跑3個，
  // 用Set記錄現在正在評分的學生id，畫面上每張卡片各自顯示自己在不在評分中
  const [batchBusyIds, setBatchBusyIds] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const BATCH_CONCURRENCY = 3;

  async function aiGradeAllBatched() {
    if (!submissions?.length) return;
    setError("");
    const queue = [...submissions];
    const total = queue.length;
    let done = 0;
    setBatchProgress({ done: 0, total });

    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        if (!s) return;
        setBatchBusyIds((prev) => new Set(prev).add(s.id));
        try {
          await api.aiGrade(s.id);
          await refreshSubmissions(); // 每評完一個就刷新，畫面能一個一個跳出結果，不用等全班跑完
        } catch (e) {
          setError(`${s.student_name}：${(e as Error).message}`);
        } finally {
          setBatchBusyIds((prev) => {
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
          done += 1;
          setBatchProgress({ done, total });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
    setBatchProgress(null);
  }

  return (
    <div>
      <Stepper current={2} />
      <Link to={`/courses/${courseId}`} state={{ courseName: assignment?.courseName }} className="back-link">
        ← 回作業列表{assignment?.courseName ? `（${assignment.courseName}）` : ""}
      </Link>
      {assignment?.title && (
        <div className="assignment-banner">
          <div className="assignment-eyebrow">正在評分</div>
          <h1 className="assignment-title">{assignment.title}</h1>
          {assignment.maxPoints != null && <div className="assignment-meta">滿分 {assignment.maxPoints} 分</div>}
        </div>
      )}

      <section className="section">
        <h2 className="section-title">
          <span className="section-index">1</span>評分標準
        </h2>
        {!rubric || editingRubric ? (
          <RubricEditor
            courseWorkId={courseWorkId!}
            defaultMaxPoints={assignment?.maxPoints}
            initial={rubric}
            onSaved={(r) => {
              setRubric(r);
              setEditingRubric(false);
            }}
          />
        ) : (
          <RubricSummary rubric={rubric} onEdit={() => setEditingRubric(true)} />
        )}
      </section>

      <section className="section">
        <h2 className="section-title">
          <span className="section-index">2</span>學生繳交
        </h2>
        <p className="section-hint">
          按「AI 評分」後結果會直接顯示在下面每位學生自己的卡片裡，不會跳到別的頁面，也不會自動送出，
          你看過覺得可以了，再按「確認定案」。
        </p>
        <div className="row" style={{ marginBottom: 16 }}>
          <button onClick={syncSubmissions} disabled={busy === "pulling"}>
            {busy === "pulling" ? "拉取中…" : "拉取最新繳交"}
          </button>
          {submissions && rubric && submissions.length > 0 && (
            <button className="secondary" onClick={aiGradeAllBatched} disabled={!!busy || !!batchProgress}>
              {batchProgress ? `評分中…（${batchProgress.done}/${batchProgress.total}）` : "全部 AI 評分"}
            </button>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}

        {submissions?.length === 0 && (
          <p className="empty-hint">目前還沒有學生繳交這份作業，繳交後按上面「拉取最新繳交」就會出現在這裡。</p>
        )}
        {submissions?.map((s) => (
          <SubmissionCard
            key={s.id}
            submission={s}
            rubricReady={!!rubric}
            busy={busy === s.id || batchBusyIds.has(s.id)}
            onAiGrade={() => aiGradeOne(s.id)}
            onSaved={refreshSubmissions}
          />
        ))}
      </section>
    </div>
  );
}

const MODE_OPTIONS: { value: Mode; label: string; hint: string }[] = [
  { value: "freetext", label: "自由文字指令", hint: "最快、最有彈性，適合大多數作業" },
  { value: "rubric", label: "評分量表", hint: "想逐項給分時用" },
  { value: "answer_key", label: "上傳檔案評分", hint: "有明確正確答案的題目：可貼文字，或直接上傳照片／PDF／Excel答案" },
];

const MAX_ANSWER_KEY_FILE_BYTES = 8 * 1024 * 1024;
const ANSWER_KEY_FILE_ACCEPT =
  "image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,.xlsx,.xls";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function RubricEditor({
  courseWorkId,
  defaultMaxPoints,
  initial,
  onSaved,
}: {
  courseWorkId: string;
  defaultMaxPoints?: number;
  initial?: any;
  onSaved: (r: any) => void;
}) {
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "freetext");
  // 預設帶一段常用的評語指令，老師照抄或微調即可，不必從空白開始想
  const [instructions, setInstructions] = useState(initial?.instructions ?? DEFAULT_INSTRUCTIONS);
  const [answerKey, setAnswerKey] = useState(initial?.answerKey ?? "");
  // 有從 Classroom 讀到這份作業的滿分就直接帶入，沒有才退回 100
  const [maxPoints, setMaxPoints] = useState(initial?.maxPoints ?? initial?.max_points ?? defaultMaxPoints ?? 100);
  const [items, setItems] = useState<RubricItem[]>(
    initial?.rubricJson?.length ? initial.rubricJson : [{ item: "", maxPoints: 0 }]
  );
  // 已存過的答案檔（只有名稱/類型，沒有內容）；選了新檔案才會換掉
  const [existingFile, setExistingFile] = useState(initial?.answerKeyFile ?? null);
  const [newFile, setNewFile] = useState<{ name: string; mimeType: string; base64: string } | null>(null);
  const [fileRemoved, setFileRemoved] = useState(false);
  const [fileError, setFileError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleFilePick(file: File | undefined) {
    setFileError("");
    if (!file) return;
    if (file.size > MAX_ANSWER_KEY_FILE_BYTES) {
      setFileError("檔案太大，請控制在 8MB 以內");
      return;
    }
    const base64 = await readFileAsBase64(file);
    setNewFile({ name: file.name, mimeType: file.type, base64 });
    setFileRemoved(false);
  }

  async function save() {
    setSaving(true);
    try {
      const body: any = { courseWorkId, mode, maxPoints };
      if (mode === "freetext") body.instructions = instructions;
      if (mode === "answer_key") {
        body.answerKey = answerKey;
        // 都不帶＝這次沒換檔案，後端會維持原本存的檔案不動；只有真的選新檔或按「移除」才需要講
        if (newFile) body.answerKeyFile = newFile;
        else if (fileRemoved) body.removeAnswerKeyFile = true;
      }
      if (mode === "rubric") body.rubricItems = items.filter((it) => it.item.trim());
      await api.saveRubric(body);
      onSaved({
        mode,
        instructions,
        answerKey,
        maxPoints,
        rubricJson: items,
        answerKeyFile: newFile ? { name: newFile.name, mimeType: newFile.mimeType } : fileRemoved ? null : existingFile,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="mode-picker">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`mode-option ${mode === opt.value ? "active" : ""}`}
            onClick={() => setMode(opt.value)}
          >
            <div className="mode-option-label">{opt.label}</div>
            <div className="mode-option-hint">{opt.hint}</div>
          </button>
        ))}
      </div>

      <div className="row field-row">
        <label className="field-label" htmlFor="maxPoints">
          總分
        </label>
        <input
          id="maxPoints"
          type="number"
          value={maxPoints}
          onChange={(e) => setMaxPoints(Number(e.target.value))}
          style={{ width: 100 }}
        />
      </div>

      {mode === "freetext" && (
        <textarea
          rows={4}
          placeholder="例如：檢查文法、邏輯是否通順、字數是否達到規定，並給出具體改進建議"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      )}

      {mode === "answer_key" && (
        <div>
          <textarea rows={4} placeholder="標準答案內容（可留空，改用下面上傳檔案）" value={answerKey} onChange={(e) => setAnswerKey(e.target.value)} />
          <div className="field-row" style={{ marginTop: 8 }}>
            <label className="field-label" htmlFor="answerKeyFile">
              或上傳答案檔（圖片／PDF／Excel，8MB 內）
            </label>
            <input
              id="answerKeyFile"
              type="file"
              accept={ANSWER_KEY_FILE_ACCEPT}
              onChange={(e) => handleFilePick(e.target.files?.[0])}
            />
          </div>
          {fileError && <p className="error-text">{fileError}</p>}
          {newFile && <p className="section-hint">已選擇新檔案：{newFile.name}</p>}
          {!newFile && existingFile && !fileRemoved && (
            <p className="section-hint">
              目前已上傳：{existingFile.name}{" "}
              <button
                type="button"
                className="secondary"
                onClick={() => setFileRemoved(true)}
                style={{ marginLeft: 8 }}
              >
                移除
              </button>
            </p>
          )}
        </div>
      )}

      {mode === "rubric" && (
        <div>
          {items.map((it, i) => (
            <div className="row" key={i} style={{ marginBottom: 6 }}>
              <input
                type="text"
                placeholder="評分項目（如：論點清晰度）"
                value={it.item}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = { ...next[i], item: e.target.value };
                  setItems(next);
                }}
              />
              <input
                type="number"
                placeholder="配分"
                value={it.maxPoints}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = { ...next[i], maxPoints: Number(e.target.value) };
                  setItems(next);
                }}
                style={{ width: 80 }}
              />
            </div>
          ))}
          <button className="secondary" onClick={() => setItems([...items, { item: "", maxPoints: 0 }])}>
            + 新增項目
          </button>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={save} disabled={saving}>
          {saving ? "儲存中…" : "儲存評分標準"}
        </button>
      </div>
    </div>
  );
}

function RubricSummary({ rubric, onEdit }: { rubric: any; onEdit: () => void }) {
  const label = { freetext: "自由文字指令", rubric: "評分量表", answer_key: "上傳檔案評分" }[rubric.mode as Mode];
  return (
    <div className="card row" style={{ justifyContent: "space-between" }}>
      <div>
        <strong>{label}</strong>（總分 {rubric.maxPoints ?? rubric.max_points}）
        {rubric.answerKeyFile && <span> ｜ 已上傳答案檔：{rubric.answerKeyFile.name}</span>}
      </div>
      <button className="secondary" onClick={onEdit}>
        重新設定
      </button>
    </div>
  );
}

function SubmissionCard({
  submission,
  rubricReady,
  busy,
  onAiGrade,
  onSaved,
}: {
  submission: Submission;
  rubricReady: boolean;
  busy: boolean;
  onAiGrade: () => void;
  onSaved: () => void;
}) {
  const [score, setScore] = useState(submission.final_score ?? submission.ai_score ?? 0);
  const [feedback, setFeedback] = useState(submission.final_feedback ?? submission.ai_feedback ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setScore(submission.final_score ?? submission.ai_score ?? 0);
    setFeedback(submission.final_feedback ?? submission.ai_feedback ?? "");
  }, [submission.final_score, submission.ai_score, submission.final_feedback, submission.ai_feedback]);

  async function save(confirm: boolean) {
    setSaving(true);
    try {
      await api.updateGrade(submission.id, { finalScore: score, finalFeedback: feedback, confirm });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const statusLabels: Record<string, string> = { ai_suggested: "AI 建議", teacher_edited: "老師已調整", confirmed: "已確認" };
  const statusLabel = statusLabels[submission.status ?? ""] ?? "尚未評分";
  const statusClass = submission.status === "confirmed" ? "confirmed" : submission.status === "teacher_edited" ? "edited" : "";

  return (
    <div className={`card submission-card ${submission.status === "ai_suggested" ? "needs-review" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{submission.student_name}</strong>
        <span className={`badge ${statusClass}`}>{statusLabel}</span>
      </div>

      {submission.content_text && (
        <p className="submission-text">{submission.content_text}</p>
      )}

      {submission.status ? (
        <div className="result-box">
          {submission.status === "ai_suggested" && (
            <div className="result-box-hint">AI 評分結果如下，看過覺得沒問題再按「確認定案」</div>
          )}
          <div className="row field-row">
            <label className="field-label">分數</label>
            <input type="number" value={score} onChange={(e) => setScore(Number(e.target.value))} style={{ width: 100 }} />
          </div>
          <label className="field-label" style={{ display: "block", marginBottom: 4 }}>
            評語
          </label>
          <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          {submission.ai_model && <div className="ai-model-tag">AI 模型：{submission.ai_model}</div>}
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => save(false)} disabled={saving} className="secondary">
              儲存修改
            </button>
            <button onClick={() => save(true)} disabled={saving}>
              確認定案
            </button>
            <button className="secondary" onClick={onAiGrade} disabled={busy}>
              {busy ? "評分中…" : "重新 AI 評分"}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={onAiGrade} disabled={!rubricReady || busy} style={{ marginTop: 8 }}>
          {busy ? "評分中…" : rubricReady ? "AI 評分" : "請先設定評分標準"}
        </button>
      )}
    </div>
  );
}
