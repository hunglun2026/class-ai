import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Stepper from "../components/Stepper";
import SafeLink from "../components/SafeLink";
import { setPending } from "../unsaved";
import { TEMPLATES, splitPoints } from "../templates";

export type Mode = "freetext" | "rubric" | "answer_key";

export interface AssignmentState {
  title?: string;
  maxPoints?: number;
  courseName?: string;
  teacherCount?: number; // 這門課有幾位老師（協同教學時 > 1）
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
  { value: "answer_key", label: "上傳檔案評分", hint: "有固定答案的題目，可以貼文字，或上傳照片、PDF、Word、Excel、純文字檔" },
];

export const MODE_LABEL: Record<Mode, string> = {
  freetext: "用文字寫要求",
  rubric: "填項目算分數",
  answer_key: "上傳檔案評分",
};

const MAX_ANSWER_KEY_FILE_BYTES = 8 * 1024 * 1024;
const TEMPLATE_NAME_MAX = 60;

// 看副檔名決定檔案類型：有些電腦選 Excel 時瀏覽器給的類型是空字串，照 file.type 會被後端當成不支援
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/plain",
};

function fileProblem(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.size === 0) return "這個檔案是空的，請重新選一次";
  if (file.size > MAX_ANSWER_KEY_FILE_BYTES) return "檔案太大，請控制在 8MB 以內（照片可以用手機截圖縮小）";
  if (ext === "doc") return "舊版 Word（.doc）讀不了，請在 Word 裡「另存新檔」成 .docx 或 PDF 再上傳，或把答案貼到上面的文字框";
  if (ext === "heic" || ext === "heif") return "iPhone 的 HEIC 照片不能上傳，請改傳截圖，或到「設定 → 相機 → 格式」改成「最相容」再拍";
  if (!EXT_MIME[ext]) return "可以上傳照片（JPG、PNG）、PDF、Word（.docx）、Excel、純文字（.txt、.md、.csv）";
  return null;
}
const ANSWER_KEY_FILE_ACCEPT =
  "image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,.xlsx,.xls,.docx,.txt,.md,.csv";

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
  const [stats, setStats] = useState<{ courseworkMaxPoints: number | null; gradedCount: number; maxGivenScore: number | null }>({
    courseworkMaxPoints: null,
    gradedCount: 0,
    maxGivenScore: null,
  });
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!courseWorkId) return;
    setLoadError("");
    api
      .getRubric(courseWorkId)
      .then((r) => {
        setStats({ courseworkMaxPoints: r.courseworkMaxPoints, gradedCount: r.gradedCount, maxGivenScore: r.maxGivenScore });
        setInitial(r.rubric);
      })
      .catch((e) => setLoadError(e.message));
  }, [courseWorkId, reloadKey]);
  // 重新整理頁面時 location.state 會不見，總分改用後端存的 Classroom 滿分
  const classroomMax = assignment?.maxPoints ?? stats.courseworkMaxPoints ?? undefined;

  const gradingPath = `/courses/${courseId}/coursework/${courseWorkId}`;

  return (
    <div>
      <Stepper current={2} />
      <SafeLink to={`/courses/${courseId}`} state={{ courseName: assignment?.courseName }} className="back-link">
        ← 上一步：換一份作業
      </SafeLink>
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

      {loadError && (
        <div className="error-text error-box" role="alert">
          <span>{loadError}</span>
          <button className="secondary small" onClick={() => setReloadKey((k) => k + 1)}>
            再試一次
          </button>
        </div>
      )}
      {initial === undefined && !loadError && <p className="muted">載入中…</p>}
      {initial !== undefined && courseWorkId && (
        <RubricForm
          courseWorkId={courseWorkId}
          defaultMaxPoints={classroomMax}
          classroomMax={classroomMax}
          gradedCount={initial ? stats.gradedCount : 0}
          maxGivenScore={stats.maxGivenScore}
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
  classroomMax,
  gradedCount,
  maxGivenScore,
  initial,
  onSaved,
}: {
  courseWorkId: string;
  defaultMaxPoints?: number;
  classroomMax?: number;
  gradedCount: number;
  maxGivenScore: number | null;
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
  // v1.19.0 讓 AI 依作業內容產生評分標準
  const [aiOpen, setAiOpen] = useState(false);
  const [aiHint, setAiHint] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [templateError, setTemplateError] = useState("");

  // 讀老師在 Classroom 網頁已經設定好的量表：只在「這份作業還沒存過 classAI 自己的量表」時才問，
  // 已經存過的就不要每次進頁面都跳出來洗版。null＝還沒查完或沒找到，不特別區分（都不顯示 banner）。
  const [classroomRubric, setClassroomRubric] = useState<{
    rubricItems: RubricItem[];
    maxPoints: number;
  } | null>(null);
  const [classroomRubricDismissed, setClassroomRubricDismissed] = useState(false);

  useEffect(() => {
    api
      .myRubricTemplates()
      .then((r) => setMyTemplates(r.templates as any))
      .catch(() => setMyTemplates([]));
  }, []);

  useEffect(() => {
    if (initial) return; // 已經存過 classAI 量表，不用再從 Classroom 帶一次
    api
      .getClassroomRubric(courseWorkId)
      .then((r) => setClassroomRubric(r.rubric))
      .catch(() => {}); // 讀不到就算了，不擋老師手動設定
  }, [courseWorkId, initial]);

  function applyClassroomRubric() {
    if (!classroomRubric) return;
    if (!confirmOverwriteContent()) return;
    setMode("rubric");
    setMaxPoints(classroomRubric.maxPoints);
    setItems(classroomRubric.rubricItems);
    setAppliedTemplate("Classroom 評分量表");
    setClassroomRubricDismissed(true);
  }

  const filledItems = items.filter((it) => it.item.trim());
  // 加總算畫面上每一列（包含還沒取名的），老師看到的數字才跟輸入框對得起來
  const subtotal = items.reduce((a, it) => a + (Number(it.maxPoints) || 0), 0);
  const rubricMismatch = mode === "rubric" && Math.abs(subtotal - maxPoints) > 1e-6;
  const rubricEmpty = mode === "rubric" && filledItems.length !== items.length;
  const answerEmpty = mode === "answer_key" && !answerKey.trim() && !newFile && (!existingFile || fileRemoved);

  // 總分：清空會變成 0（Number("")），以前按鈕變灰卻沒說為什麼
  const totalError = !Number.isFinite(maxPoints) || maxPoints <= 0
    ? "總分要填大於 0 的數字"
    : maxPoints > 1000
      ? "總分最多 1000 分"
      : "";
  // 量表每一列的問題：配分不是正數、名稱重複（名稱空白另外由 rubricEmpty 提示）
  const itemProblems: string[] = [];
  if (mode === "rubric") {
    const badPoints = items.map((it, i) => (!Number.isFinite(Number(it.maxPoints)) || Number(it.maxPoints) <= 0 ? i + 1 : 0)).filter(Boolean);
    if (badPoints.length) itemProblems.push(`第 ${badPoints.join("、")} 項的配分要大於 0`);
    const seen = new Map<string, number[]>();
    items.forEach((it, i) => {
      const k = it.item.trim();
      if (k) seen.set(k, [...(seen.get(k) ?? []), i + 1]);
    });
    const dups = [...seen.values()].filter((rows) => rows.length > 1);
    if (dups.length) itemProblems.push(`第 ${dups.map((r) => r.join("、")).join("；")} 項的名稱重複了，AI 會分不清楚`);
  }
  const canSave = !saving && !totalError && !itemProblems.length && !rubricMismatch && !rubricEmpty && !answerEmpty;

  // 不擋，但要讓老師知道的事
  const classroomMismatch = classroomMax != null && !totalError && classroomMax !== maxPoints;
  const lowerThanGiven = maxGivenScore != null && !totalError && maxPoints < maxGivenScore;

  // 還沒存的修改：跟一進頁面時的內容比，有差就登記，換頁或關分頁前會問
  const snapshot = JSON.stringify({ mode, instructions, answerKey, maxPoints, items, f: newFile?.name ?? null, fileRemoved });
  const initialSnapshot = useRef(snapshot);
  const dirty = snapshot !== initialSnapshot.current;
  useEffect(() => {
    setPending("rubric", dirty);
    return () => setPending("rubric", false);
  }, [dirty]);

  // 套用範本會蓋掉老師寫好的內容：有寫東西才問，空白或預設內容直接套
  function confirmOverwriteContent(): boolean {
    const hasContent =
      (instructions.trim() && instructions !== DEFAULT_INSTRUCTIONS) ||
      items.some((it) => it.item.trim()) ||
      answerKey.trim();
    return !hasContent || window.confirm("套用範本會取代你目前寫的評分內容，確定要套用嗎？");
  }

  function applyTemplate(key: string) {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    if (!confirmOverwriteContent()) return;
    setInstructions(t.instructions);
    const pts = splitPoints(
      t.items.map((i) => i.weight),
      maxPoints
    );
    setItems(t.items.map((i, idx) => ({ item: i.item, maxPoints: pts[idx] })));
    setAppliedTemplate(t.label);
  }

  // AI 產生的內容只填進表單，老師看過、修改、按儲存才算數
  async function generateWithAi() {
    if (mode === "answer_key") return;
    if (!confirmOverwriteContent()) return;
    setAiBusy(true);
    setAiError("");
    try {
      const r = await api.generateRubric(courseWorkId, { mode, maxPoints, hint: aiHint.trim() || undefined });
      if (r.mode === "rubric" && r.items?.length) setItems(r.items);
      if (r.mode === "freetext" && r.instructions) setInstructions(r.instructions);
      setAppliedTemplate("AI 依作業內容產生");
      setAiOpen(false);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }
  const aiBlocked = mode === "rubric" && (!Number.isInteger(maxPoints) || maxPoints < 1);

  async function applyMyTemplate(id: string) {
    setTemplateError("");
    if (!confirmOverwriteContent()) return;
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
    const name = window.prompt(`這個範本要取什麼名字？（例如：國一作文評分標準，最多 ${TEMPLATE_NAME_MAX} 個字）`)?.trim();
    if (!name) return;
    if (name.length > TEMPLATE_NAME_MAX) {
      setTemplateError(`範本名稱最多 ${TEMPLATE_NAME_MAX} 個字，請取短一點`);
      return;
    }
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

  async function handleFilePick(input: HTMLInputElement) {
    setFileError("");
    const file = input.files?.[0];
    // 清掉選取紀錄：選錯檔之後再選同一個檔案也能觸發（不然 onChange 不會再跑）
    input.value = "";
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) {
      setFileError(problem);
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      setNewFile({ name: file.name, mimeType: EXT_MIME[ext], base64 });
      setFileRemoved(false);
    } catch {
      setFileError("讀不到這個檔案，請重新選一次");
    }
  }

  async function save() {
    if (!canSave) return;
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
      // 存好了就不算「沒存的修改」，接下來自動換頁不用再問
      setPending("rubric", false);
      initialSnapshot.current = snapshot;
      onSaved();
    } catch (e) {
      setSaveError(`沒有存成功：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card form-card">
      {classroomRubric && !classroomRubricDismissed && (
        <div className="info-box classroom-rubric-banner">
          <div>
            <strong>已從 Google Classroom 找到這份作業的評分量表</strong>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              你在 Classroom 網頁設定過（共 {classroomRubric.rubricItems.length} 個評分項目，總分{" "}
              {classroomRubric.maxPoints} 分），可以直接套用，不用在這裡重打一次。
            </p>
          </div>
          <div className="button-row">
            <button type="button" className="primary small" onClick={applyClassroomRubric}>
              使用這份量表
            </button>
            <button type="button" className="ghost small" onClick={() => setClassroomRubricDismissed(true)}>
              不用，我自己設定
            </button>
          </div>
        </div>
      )}
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
      {totalError && <p className="error-text" role="alert">{totalError}</p>}
      {classroomMismatch && (
        <p className="warn-text">
          Classroom 這份作業的滿分是 {classroomMax} 分，這裡設 {maxPoints} 分。分數貼回 Classroom 時會對不上，確定不一樣再存。
        </p>
      )}
      {gradedCount > 0 && (
        <p className="warn-text">
          這份作業已經有 {gradedCount} 位評過分了。改評分標準不會自動重評，要重評請到批改頁對那幾位按「請 AI 重評」。
        </p>
      )}
      {lowerThanGiven && (
        <p className="error-text" role="alert">
          注意：有學生目前是 {maxGivenScore} 分，比新的總分 {maxPoints} 分還高。存了之後，那些學生的分數要自己重新調整。
        </p>
      )}

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
          <div className="ai-gen">
            {!aiOpen ? (
              <button type="button" className="secondary small" onClick={() => setAiOpen(true)}>
                ✨ 讓 AI 依作業內容幫我寫
              </button>
            ) : (
              <div className="ai-gen-panel">
                <label className="field-label block" htmlFor="ai-hint">
                  補充年級或想看的重點（選填）
                </label>
                <input
                  id="ai-hint"
                  type="text"
                  maxLength={300}
                  placeholder="例如：五年級，重點看有沒有引用課文"
                  value={aiHint}
                  onChange={(e) => setAiHint(e.target.value)}
                />
                <p className="small-text muted">
                  AI 會參考 Classroom 上這份作業的標題和說明，{mode === "rubric" ? "寫出 3～5 個評分項目、配分和給分說明" : "寫一段評分要求"}
                  ，填進下面讓你改。用 1 次 AI 次數，不會自動儲存。
                </p>
                {aiBlocked && <p className="error-text">總分要是大於 0 的整數，AI 才能分配各項配分</p>}
                {aiError && (
                  <p className="error-text" role="alert">
                    {aiError}
                  </p>
                )}
                <div className="row">
                  <button type="button" onClick={generateWithAi} disabled={aiBusy || aiBlocked}>
                    {aiBusy ? "AI 撰寫中（約 10～20 秒）…" : "開始產生"}
                  </button>
                  <button type="button" className="ghost" onClick={() => setAiOpen(false)} disabled={aiBusy}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
          {appliedTemplate && <p className="ok-text">已套用「{appliedTemplate}」，可以直接修改內容。</p>}
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
              <input
                type="text"
                className="rubric-desc"
                aria-label={`第 ${i + 1} 項給分說明`}
                placeholder="給分說明（選填），例如：完整說明且舉例得滿分；只說明沒舉例約一半"
                maxLength={1000}
                value={it.description ?? ""}
                onChange={(e) => {
                  const next = [...items];
                  next[i] = { ...next[i], description: e.target.value };
                  setItems(next);
                }}
              />
            </div>
          ))}
          {itemProblems.map((p) => (
            <p key={p} className="error-text" role="alert">
              {p}
            </p>
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
            placeholder="把標準答案貼在這裡；或是在下面上傳答案的照片、PDF、Word、Excel 或純文字檔"
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
              onChange={(e) => handleFilePick(e.currentTarget)}
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
          {totalError
            ? totalError
            : itemProblems.length
              ? "量表有項目要修正，看上面紅字"
              : rubricEmpty
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
