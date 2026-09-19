import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";
import { TEMPLATES, splitPoints } from "../templates";

export type Mode = "freetext" | "rubric" | "answer_key";

export interface AssignmentState {
  title?: string;
  maxPoints?: number;
  courseName?: string;
}

interface RubricItem {
  item: string;
  maxPoints: number;
  description?: string;
}

const DEFAULT_INSTRUCTIONS =
  "請評估這份作業是否切題、內容是否清楚、有沒有明顯錯字或邏輯問題，並給一個具體的改進建議。";

export const MODE_OPTIONS: { value: Mode; label: string; hint: string }[] = [
  { value: "freetext", label: "用文字寫要求", hint: "打幾句話告訴 AI 怎麼改，適合大部分作業" },
  { value: "rubric", label: "填項目算分數", hint: "分成幾個項目各自配分，例如作文" },
  { value: "answer_key", label: "上傳檔案評分", hint: "有固定答案的題目，可以貼文字或上傳照片／PDF／Excel" },
];

export const MODE_LABEL: Record<Mode, string> = {
  freetext: "用文字寫要求",
  rubric: "填項目算分數",
  answer_key: "上傳檔案評分",
};

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

export default function RubricSetup() {
  const { courseId, courseWorkId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const assignment = (location.state as AssignmentState | null) ?? null;
  const [initial, setInitial] = useState<any>(undefined);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!courseWorkId) return;
    api
      .getRubric(courseWorkId)
      .then((r) => setInitial(r.rubric))
      .catch((e) => setLoadError(e.message));
  }, [courseWorkId]);

  const gradingPath = `/courses/${courseId}/coursework/${courseWorkId}`;

  return (
    <div>
      <Stepper current={2} />
      <Link to={`/courses/${courseId}`} state={{ courseName: assignment?.courseName }} className="back-link">
        ← 上一步：換一份作業
      </Link>
      <div className="page-head">
        <div className="eyebrow">第 3 步</div>
        <h1 className="page-title">這份作業要怎麼評分？</h1>
        {assignment?.title && (
          <p className="page-sub">
            {assignment.title}
            {assignment.maxPoints != null && `（滿分 ${assignment.maxPoints} 分）`}
          </p>
        )}
      </div>

      {loadError && <p className="error-text">{loadError}</p>}
      {initial === undefined && !loadError && <p className="muted">載入中…</p>}
      {initial !== undefined && courseWorkId && (
        <RubricForm
          courseWorkId={courseWorkId}
          defaultMaxPoints={assignment?.maxPoints}
          initial={initial}
          onSaved={() => navigate(gradingPath, { state: assignment, replace: true })}
        />
      )}
    </div>
  );
}

function RubricForm({
  courseWorkId,
  defaultMaxPoints,
  initial,
  onSaved,
}: {
  courseWorkId: string;
  defaultMaxPoints?: number;
  initial: any;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "freetext");
  const [instructions, setInstructions] = useState<string>(initial?.instructions ?? DEFAULT_INSTRUCTIONS);
  const [answerKey, setAnswerKey] = useState<string>(initial?.answerKey ?? initial?.answer_key ?? "");
  const [maxPoints, setMaxPoints] = useState<number>(
    initial?.maxPoints ?? initial?.max_points ?? defaultMaxPoints ?? 100
  );
  const [items, setItems] = useState<RubricItem[]>(
    initial?.rubricJson?.length ? initial.rubricJson : [{ item: "", maxPoints: defaultMaxPoints ?? 100 }]
  );
  const [existingFile] = useState(initial?.answerKeyFile ?? null);
  const [newFile, setNewFile] = useState<{ name: string; mimeType: string; base64: string } | null>(null);
  const [fileRemoved, setFileRemoved] = useState(false);
  const [fileError, setFileError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [appliedTemplate, setAppliedTemplate] = useState("");
  const [myTemplates, setMyTemplates] = useState<
    { id: string; name: string; mode: Mode; max_points: number; created_at: number }[] | null
  >(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState("");

  useEffect(() => {
    api
      .myRubricTemplates()
      .then((r) => setMyTemplates(r.templates as any))
      .catch(() => setMyTemplates([]));
  }, []);

  const filledItems = items.filter((it) => it.item.trim());
  // 加總算畫面上每一列（包含還沒取名的），老師看到的數字才跟輸入框對得起來
  const subtotal = items.reduce((a, it) => a + (Number(it.maxPoints) || 0), 0);
  const rubricMismatch = mode === "rubric" && subtotal !== maxPoints;
  const rubricEmpty = mode === "rubric" && filledItems.length !== items.length;
  const answerEmpty = mode === "answer_key" && !answerKey.trim() && !newFile && (!existingFile || fileRemoved);
  const canSave = !saving && maxPoints > 0 && !rubricMismatch && !rubricEmpty && !answerEmpty;

  function applyTemplate(key: string) {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setInstructions(t.instructions);
    const pts = splitPoints(
      t.items.map((i) => i.weight),
      maxPoints
    );
    setItems(t.items.map((i, idx) => ({ item: i.item, maxPoints: pts[idx] })));
    setAppliedTemplate(t.label);
  }

  async function applyMyTemplate(id: string) {
    setTemplateError("");
    try {
      const { template: t } = await api.getRubricTemplate(id);
      setMode(t.mode);
      if (t.mode === "freetext") setInstructions(t.instructions ?? DEFAULT_INSTRUCTIONS);
      if (t.mode === "answer_key") setAnswerKey(t.answerKey ?? "");
      if (t.mode === "rubric" && t.rubricJson?.length) {
        // 範本自己的配分是依它存下來當時的總分算的，套到目前這份作業要照比例換算，
        // 不是直接搬過來（跟內建範本applyTemplate同一招）
        const pts = splitPoints(
          t.rubricJson.map((i: RubricItem) => i.maxPoints),
          maxPoints
        );
        setItems(t.rubricJson.map((i: RubricItem, idx: number) => ({ item: i.item, maxPoints: pts[idx] })));
      }
      setAppliedTemplate(t.name);
    } catch (e) {
      setTemplateError(`套用範本失敗：${(e as Error).message}`);
    }
  }

  async function saveAsTemplate() {
    const name = window.prompt("這個範本要取什麼名字？（例如：國一作文評分標準）")?.trim();
    if (!name) return;
    setTemplateBusy(true);
    setTemplateError("");
    try {
      const body: any = { name, mode, maxPoints };
      if (mode === "freetext") body.instructions = instructions;
      if (mode === "rubric") body.rubricItems = filledItems;
      if (mode === "answer_key") body.answerKey = answerKey;
      await api.saveRubricTemplate(body);
      const r = await api.myRubricTemplates();
      setMyTemplates(r.templates as any);
    } catch (e) {
      setTemplateError(`存範本失敗：${(e as Error).message}`);
    } finally {
      setTemplateBusy(false);
    }
  }

  async function deleteMyTemplate(id: string) {
    setTemplateBusy(true);
    setTemplateError("");
    try {
      await api.deleteRubricTemplate(id);
      setMyTemplates((prev) => (prev ?? []).filter((t) => t.id !== id));
    } catch (e) {
      setTemplateError(`刪除失敗：${(e as Error).message}`);
    } finally {
      setTemplateBusy(false);
    }
  }

  const canSaveTemplate =
    !templateBusy &&
    ((mode === "freetext" && instructions.trim().length > 0) ||
      (mode === "rubric" && filledItems.length > 0) ||
      (mode === "answer_key" && answerKey.trim().length > 0));

  function splitEvenly() {
    const pts = splitPoints(
      items.map(() => 1),
      maxPoints
    );
    setItems(items.map((it, i) => ({ ...it, maxPoints: pts[i] })));
  }

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
    setSaveError("");
    try {
      const body: any = { courseWorkId, mode, maxPoints };
      if (mode === "freetext") body.instructions = instructions;
      if (mode === "answer_key") {
        body.answerKey = answerKey;
        // 都不帶＝這次沒換檔案，後端會維持原本存的檔案不動；只有真的選新檔或按「移除」才需要講
        if (newFile) body.answerKeyFile = newFile;
        else if (fileRemoved) body.removeAnswerKeyFile = true;
      }
      if (mode === "rubric") body.rubricItems = filledItems;
      await api.saveRubric(body);
      onSaved();
    } catch (e) {
      setSaveError(`沒有存成功：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card form-card">
      <h2 className="form-step">
        <span className="section-index">1</span>選一種評分方式
      </h2>
      <div className="mode-picker" role="radiogroup">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={mode === opt.value}
            className={`mode-option ${mode === opt.value ? "active" : ""}`}
            onClick={() => setMode(opt.value)}
          >
            <div className="mode-option-label">{opt.label}</div>
            <div className="mode-option-hint">{opt.hint}</div>
          </button>
        ))}
      </div>

      {myTemplates && myTemplates.length > 0 && (
        <div className="my-templates-bar">
          <span className="template-label">📂 我的範本：</span>
          <div className="chip-row">
            {myTemplates.map((t) => (
              <span key={t.id} className="chip-with-delete">
                <button type="button" className="chip" onClick={() => applyMyTemplate(t.id)} disabled={templateBusy}>
                  {t.name}
                </button>
                <button
                  type="button"
                  className="ghost icon-btn small"
                  aria-label={`刪除範本「${t.name}」`}
                  onClick={() => {
                    if (window.confirm(`刪除範本「${t.name}」？這個動作不能復原。`)) deleteMyTemplate(t.id);
                  }}
                  disabled={templateBusy}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="row" style={{ marginBottom: 14 }}>
        <button type="button" className="secondary small" onClick={saveAsTemplate} disabled={!canSaveTemplate}>
          {templateBusy ? "處理中…" : "⭐ 存為我的範本"}
        </button>
      </div>
      {templateError && <p className="error-text">{templateError}</p>}

      <div className="row field-row">
        <label className="field-label" htmlFor="maxPoints">
          總分
        </label>
        <input
          id="maxPoints"
          type="number"
          inputMode="numeric"
          min={1}
          value={maxPoints}
          onChange={(e) => setMaxPoints(Number(e.target.value))}
          className="input-short"
        />
        <span className="muted">分</span>
      </div>

      <h2 className="form-step">
        <span className="section-index">2</span>
        {mode === "answer_key" ? "給 AI 標準答案" : "告訴 AI 怎麼改"}
      </h2>

      {mode !== "answer_key" && (
        <div className="template-bar">
          <span className="template-label">不知道怎麼寫？套用範本：</span>
          <div className="chip-row">
            {TEMPLATES.map((t) => (
              <button key={t.key} type="button" className="chip" onClick={() => applyTemplate(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {appliedTemplate && <p className="ok-text">已套用「{appliedTemplate}」範本，可以直接修改內容。</p>}
        </div>
      )}

      {mode === "freetext" && (
        <textarea
          rows={5}
          aria-label="給 AI 的評分要求"
          placeholder="例如：檢查有沒有切題、段落是否清楚、錯字多不多，並給一個具體的修改建議"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      )}

      {mode === "rubric" && (
        <div>
          <div className="rubric-head muted">
            <span>評分項目</span>
            <span>配分</span>
          </div>
          {items.map((it, i) => (
            <div className="rubric-row" key={i}>
              <input
                type="text"
                aria-label={`第 ${i + 1} 項名稱`}
                placeholder="例如：內容與立意"
                value={it.item}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = { ...next[i], item: e.target.value };
                  setItems(next);
                }}
              />
              <input
                type="number"
                inputMode="numeric"
                aria-label={`第 ${i + 1} 項配分`}
                value={it.maxPoints}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = { ...next[i], maxPoints: Number(e.target.value) };
                  setItems(next);
                }}
              />
              <button
                type="button"
                className="ghost icon-btn"
                aria-label={`刪除第 ${i + 1} 項`}
                onClick={() => setItems(items.length > 1 ? items.filter((_, j) => j !== i) : items)}
                disabled={items.length <= 1}
              >
                ✕
              </button>
            </div>
          ))}
          <div className={`subtotal ${rubricMismatch ? "bad" : "good"}`}>
            各項加起來 {subtotal} 分／總分 {maxPoints} 分
            {rubricMismatch && `（${subtotal > maxPoints ? "多了" : "還差"} ${Math.abs(maxPoints - subtotal)} 分）`}
          </div>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => setItems([...items, { item: "", maxPoints: Math.max(0, maxPoints - subtotal) }])}
            >
              + 新增項目
            </button>
            <button type="button" className="secondary" onClick={splitEvenly}>
              平均分配
            </button>
          </div>
        </div>
      )}

      {mode === "answer_key" && (
        <div>
          <textarea
            rows={4}
            aria-label="標準答案"
            placeholder="把標準答案貼在這裡；或是在下面上傳答案的照片、PDF、Excel"
            value={answerKey}
            onChange={(e) => setAnswerKey(e.target.value)}
          />
          <label className="upload-box" htmlFor="answerKeyFile">
            <span className="upload-title">上傳答案檔</span>
            <span className="muted">照片、PDF 或 Excel，8MB 以內</span>
            <input
              id="answerKeyFile"
              type="file"
              accept={ANSWER_KEY_FILE_ACCEPT}
              onChange={(e) => handleFilePick(e.target.files?.[0])}
            />
          </label>
          {fileError && <p className="error-text">{fileError}</p>}
          {newFile && <p className="ok-text">已選擇：{newFile.name}</p>}
          {!newFile && existingFile && !fileRemoved && (
            <p className="muted row">
              目前的答案檔：{existingFile.name}
              <button type="button" className="secondary small" onClick={() => setFileRemoved(true)}>
                移除
              </button>
            </p>
          )}
        </div>
      )}

      {saveError && <p className="error-text">{saveError}</p>}
      <div className="form-footer">
        <button className="primary-lg" onClick={save} disabled={!canSave}>
          {saving ? "儲存中…" : "儲存，開始批改"}
        </button>
        <span className="muted">
          {rubricEmpty
            ? "每個項目都要填名稱（用不到的列按 ✕ 刪掉），或直接套用上面的範本"
            : rubricMismatch
              ? "各項配分加起來要等於總分才能儲存"
              : answerEmpty
                ? "請貼上標準答案或上傳答案檔"
                : "之後隨時可以回來修改"}
        </span>
      </div>
    </div>
  );
}
