const STEPS = ["選課程", "選作業", "設定評分標準", "批改學生"];

export default function Stepper({ current }: { current: number }) {
  return (
    <div className="stepper" aria-label={`第 ${current + 1} 步，共 ${STEPS.length} 步：${STEPS[current]}`}>
      {STEPS.map((label, i) => (
        <div key={label} className={`stepper-item ${i === current ? "active" : ""} ${i < current ? "done" : ""}`}>
          <span className="stepper-dot">{i < current ? "✓" : i + 1}</span>
          <span className="stepper-label">{label}</span>
          {i < STEPS.length - 1 && <span className="stepper-line" />}
        </div>
      ))}
    </div>
  );
}
