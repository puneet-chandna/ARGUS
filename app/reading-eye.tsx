import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { estimateCopy, progressValue, stageLabels, stageText, type RunProgress, type Stage } from "../lib/progress";
import "./reading-eye.css";

const stages: Stage[] = ["uploading", "reading", "locating_rate_card", "resolving", "verifying"];

export const ReadingEye = memo(function ReadingEye() {
  return <div className="reading-eye" aria-hidden="true">
    <div className="eye-breath">
      <div className="eye-lens">
        <div className="eye-pixels">{Array.from({ length: 45 }, (_, index) =>
          <i key={index} data-tone={Math.abs(4 - index % 9)} style={{
            "--d": `-${(index * 31 % 29) / 10}s`, "--twinkle": `${1.8 + (index * 7 % 17) / 10}s`,
          } as CSSProperties} />,
        )}</div>
        <div className="eye-scan" />
      </div>
      <svg className="eye-outline" viewBox="0 0 100 60" fill="none">
        <path d="M2 30 Q50 -22 98 30 Q50 82 2 30Z" />
      </svg>
      <div className="eye-track"><div className="eye-beat"><div className="eye-gold" /></div></div>
      <div className="eye-lid" />
    </div>
  </div>;
});

function StageCaption({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (shown === text) return;
    if (text === "Done" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(text);
      return;
    }
    const timer = setTimeout(() => setShown(text), 120);
    return () => clearTimeout(timer);
  }, [shown, text]);
  return <h2 className="eye-caption" id="analysis-stage-title">
    <span key={shown} data-exit={shown !== text && text !== "Done"}>{shown}</span>
  </h2>;
}

export function ReadingStage({ progress, short, beating, reason, onCancel, onRetry, onDetails, disabled }: {
  progress: RunProgress; short: boolean; beating: boolean; reason?: string | null;
  onCancel: () => void; onRetry: () => void; onDetails: () => void; disabled: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [paused, setPaused] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef({ stage: "", milestone: 0 });
  const highest = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const terminal = progress.stage === "failed" || progress.stage === "cancelled";
  const final = beating && !terminal;
  const copy = final ? "Done" : stageText(progress);
  const value = final ? 100 : Math.max(highest.current, Math.min(97, progressValue(progress)));
  useEffect(() => { highest.current = value; }, [value]);
  useEffect(() => {
    if (final) return; // The workspace announces completion after focus moves.
    const milestone = short ? 0 : [75, 50, 25].find(percent => value >= percent) ?? 0;
    const stageChange = announced.current.stage !== progress.stage;
    const reached = milestone > announced.current.milestone;
    if (stageChange || reached) setAnnouncement([
      stageChange && stageLabels[progress.stage], reached && `${milestone} percent complete.`,
    ].filter(Boolean).join(". ").replace(/\.\./g, "."));
    announced.current = { stage: progress.stage, milestone };
  }, [final, short, progress.stage, value]);

  const elapsed = Math.max(0, Math.floor((now - Date.parse(progress.startedAt)) / 1000));
  const stale = !terminal && !final ? now - Date.parse(progress.updatedAt) : 0;
  const page = progress.page;
  const count = progress.pagesTotal ?? 0;
  const done = new Set(progress.completedPages ?? []);
  const cached = new Set(progress.cachedPages ?? []);
  const step = final ? stages.length : Math.max(0, stages.indexOf(progress.stage === "matching" ? "resolving" : progress.stage));
  const segmented = count > 30;
  return <section className="reading-stage" data-short={short} data-beat={final} data-terminal={terminal}
    data-paused={paused || terminal} aria-labelledby="analysis-stage-title"
    style={{ "--page": count > 1 ? ((page ?? 1) - 1) / (count - 1) : .5, "--stage": step } as CSSProperties}>
    <div className="eye-slot"><ReadingEye /></div>
    <StageCaption text={copy} />
    <div className="eye-pages-slot">
      {!short && count > 0 && <div className="eye-pages" data-segmented={segmented} aria-hidden="true">
        {Array.from({ length: count }, (_, index) => {
          const number = index + 1;
          const state = terminal && number === page && progress.stage === "failed" ? "failed" :
            cached.has(number) ? "cached" : done.has(number) || final ? "done" : number === page ? "reading" : "queued";
          return <span key={number} className="eye-page-ripple" style={{ "--i": index } as CSSProperties}>
            <span className="eye-page" data-state={state}>{!segmented && (state === "done" ?
              <span className="eye-check">✓</span> : state === "cached" ? "•" : null)}</span>
          </span>;
        })}
      </div>}
      {short && <div className="eye-parts">{Object.entries(progress.partial ?? {}).map(([field, value]) =>
        value && <span className="eye-chip" key={field}>{value}</span>)}</div>}
    </div>
    <div className="eye-meter-slot">
      {!short && <div className="eye-meter">
        <div className="eye-steps" aria-hidden="true">{stages.map((stage, index) =>
          <i key={stage} data-current={index === step} data-past={index < step} />,
        )}</div>
        <div className="eye-progress" role="progressbar" aria-label="Policy analysis" aria-valuemin={0}
          aria-valuemax={100} aria-valuenow={value} aria-valuetext={copy}>
          <span className="eye-progress-fill" style={{ "--fraction": value / 100 } as CSSProperties}><i /></span>
        </div>
      </div>}
    </div>
    <div className="eye-meta">
      {terminal ? <p>{reason || (progress.stage === "cancelled" ? "Your original PDF is saved." : "Retry from the saved PDF.")}</p> :
        (!short || elapsed >= 5) && <p><time className="eye-time">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</time>
          {!short && <> · {progress.estimatedSeconds ? `Usually ${estimateCopy(progress.estimatedSeconds)} for this PDF.` :
            "New PDFs can take a few minutes."}</>}</p>}
      {!short && <div className="eye-parts">{Object.entries(progress.partial ?? {}).map(([field, value]) =>
        value && <span className="eye-chip" key={field}>{value}</span>)}</div>}
    </div>
    <p className="eye-stall">{stale >= 20_000 && <span>{page ? `Still working on page ${page}. Scanned pages take longer.` :
      "Still working. This step is taking longer than usual."}</span>}</p>
    <footer className="eye-actions">
      {!terminal && <button className="button secondary" type="button" onClick={onCancel} disabled={disabled || final}>Cancel analysis</button>}
      {(terminal || stale >= 90_000) && <button className="button primary" type="button" onClick={onRetry} disabled={disabled}>Retry</button>}
      {terminal ? <button className="button secondary" type="button" onClick={onDetails}>View run details</button> :
        <button className="eye-pause" type="button" onClick={() => setPaused(value => !value)} aria-pressed={paused}>
          {paused ? "Resume animation" : "Pause animation"}
        </button>}
    </footer>
    <p className="sr-only" role="status" aria-atomic="true">{announcement}</p>
  </section>;
}
