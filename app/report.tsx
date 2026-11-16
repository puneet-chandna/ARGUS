import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import processingMonogram from "./argus-processing.svg";
import stillMonogram from "./icon.svg";
import { readerNotice } from "./ocr";
import { confirmationError, conflictFields, requiredReviewFields, reviewFields } from "../lib/review-fields";
import "./workspace.css";

export type Source = {
  file: string;
  page?: number;
  row?: string | number;
  sheet?: string;
  cells?: string;
  quote?: string;
  raw?: string;
  reader?: string;
  box?: [number, number, number, number] | null;
};

type Fact = {
  value: string | number | null;
  status: string;
  reason: string;
  evidence: Source[];
  confirmation?: { page: number };
};

type Decision = "resolved" | "ambiguous" | "unsupported";
type Rate = { applicable: boolean | null; rate: string | number | null; status: string; reason: string };
type Report = {
  status: Decision;
  confidence: { level: string; reason: string };
  od: Rate;
  tp: Rate;
  fields: Record<string, Fact>;
  review_fields?: readonly string[];
  trace: { step: string; sources: Source[] }[];
  rating_trace_start?: number;
  rule_version?: string;
  reader_failures?: Record<string, Record<string, string>>;
};

export type Run = {
  id: string;
  filename: string;
  display_name?: string | null;
  pinned?: boolean;
  deleting_at?: string | null;
  checksum: string;
  status: "queued" | "processing" | "complete" | "failed";
  decision?: Decision | null;
  result?: Report | null;
  error?: string | null;
  created_at: string;
  revision: number;
  lease_until?: string | null;
  ocr_progress?: { completed: number; total: number } | null;
};

type Clarification = { field: string; value: string; page: number };
export type ReviewSubmission = { confirmations: Clarification[]; revision: number; guided?: true };

const labels = {
  deleting: "Deletion pending",
  queued: "Queued",
  processing: "Analyzing",
  complete: "Completed",
  failed: "Interrupted",
  resolved: "Resolved",
  ambiguous: "Needs review",
  unsupported: "Unsupported",
};

const statusIcons = {
  resolved: "m3 8 3 3 7-7",
  ambiguous: "M8 4v4m0 3v.5",
  unsupported: "m5 5 6 6m0-6-6 6",
  failed: "M8 4v4m0 3v.5",
} as const;

export function RunStatus({ status }: { status: keyof typeof labels }) {
  return <span className={`state ${status}`}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="7" />
      {status in statusIcons && <path d={statusIcons[status as keyof typeof statusIcons]} />}
    </svg>
    {labels[status]}
  </span>;
}

export const runRateLabel = (rate: number | string) => `${rate}%`;

const fieldLabels: Record<string, string> = {
  engine_cc: "Engine capacity",
  current_ncb: "Current NCB",
  previous_ncb: "Previous NCB",
  rto: "RTO",
  rto_location: "RTO location",
  basic_od_premium: "Basic OD premium",
  net_od_premium: "Net OD premium",
  basic_tp_premium: "Basic TP premium",
  net_tp_premium: "Net TP premium",
  eligible_private_car_gwp: "Eligible private-car GWP",
};

function fieldName(field: string) {
  return fieldLabels[field] ?? field[0].toUpperCase() + field.slice(1).replaceAll("_", " ");
}

function factReason(reason: string) {
  return ({
    conflicting_readings: "The readings disagree.",
    ambiguous_date: "The date can be read more than one way.",
    incomplete_independent_page_coverage: "The readers could not verify every page.",
    insufficient_agreement: "Two independent readings could not verify this value.",
    invalid_or_ungrounded: "The reading could not be tied to policy evidence.",
    invalid_coverage_period: "The coverage dates are out of order.",
    premium_totals_disagree: "The printed premium and tax do not reconcile.",
    vehicle_body_style_only: "The reading describes the body style. Confirm how the vehicle is classified for this policy.",
  } as Record<string, string>)[reason] ?? "No value could be verified.";
}

function gridSource(source: Source) {
  return Boolean(source.sheet || source.row != null);
}

function Citation({ source, pdf, showFile = true }: { source: Source; pdf: string; showFile?: boolean }) {
  if (gridSource(source)) {
    const location = source.sheet
      ? `${source.sheet}${source.cells ? `!${source.cells}` : ""}`
      : `Page ${source.page} · ${source.row}`;
    return <span className="run-grid-citation">
      <span className="run-location">{location}</span>
      {showFile && <span>{source.file}</span>}
    </span>;
  }
  if (source.page) return <a className="run-policy-link" href={`${pdf}#page=${source.page}`} target="_blank" rel="noreferrer"
    aria-label={`Open ${source.file}, page ${source.page}, in a new tab`}>Policy page {source.page}</a>;
  return <span>{source.file}</span>;
}

function Sources({ items, pdf }: { items: Source[]; pdf: string }) {
  if (!items.length) return null;
  const groups = new Map<string, Source[]>();
  for (const source of items) {
    const citation = JSON.stringify([source.file, source.page, source.sheet, source.cells, source.row]);
    const key = gridSource(source) ? `grid:${source.file}` : source.quote?.trim().toLowerCase().replace(/\s+/g, " ") || citation;
    const group = groups.get(key) ?? [];
    const duplicate = group.some(item => item.file === source.file && item.page === source.page &&
      item.sheet === source.sheet && item.cells === source.cells && item.row === source.row);
    if (!duplicate) group.push(source);
    groups.set(key, group);
  }
  return <ul className="run-sources" role="list">{[...groups].map(([key, group]) => <li key={key}>
    {group[0].quote && <blockquote>{group[0].quote}</blockquote>}
    {gridSource(group[0]) && <p className="run-grid-file">{group[0].file}</p>}
    <div className="run-citation-links">{group.map((source, index) =>
      <Citation key={index} source={source} pdf={pdf} showFile={false} />)}</div>
  </li>)}</ul>;
}

function readingGroups(evidence: Source[]) {
  const groups = new Map<string, Source[]>();
  for (const source of evidence) {
    if (!source.raw || !source.page) continue;
    const key = source.reader ?? "unknown";
    const readings = groups.get(key) ?? [];
    const duplicate = readings.findIndex(item => item.raw?.toLowerCase() === source.raw?.toLowerCase());
    if (duplicate === -1) readings.push(source);
    else if (!readings[duplicate].box && source.box) readings[duplicate] = source;
    groups.set(key, readings);
  }
  return [...groups.values()];
}

function ConfirmField({ field, fact, page, openPage, pages, draft, conflicting, working, advanced, onConfirm }: {
  field: string;
  fact?: Fact;
  page: number;
  openPage: (page: number, source?: Source) => void;
  pages: number;
  draft?: Clarification;
  conflicting: boolean;
  working: boolean;
  advanced: boolean;
  onConfirm: (value: Clarification) => void;
}) {
  const groups = readingGroups(fact?.evidence ?? []);
  const candidates = groups.flat().filter(source => source.raw && !confirmationError(field, source.raw));
  const suggestion = candidates[0] && candidates.every(source => source.raw?.toLowerCase() === candidates[0].raw?.toLowerCase())
    ? candidates[0] : undefined;
  const [custom, setCustom] = useState(!conflicting || Boolean(draft));
  const [value, setValue] = useState(draft?.value ?? "");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const answer = value.trim();
  const citedPage = page;

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!answer || !citedPage || citedPage > pages || working) return;
    const error = confirmationError(field, answer);
    setError(error ?? "");
    if (!error) onConfirm({ field, value: answer, page: citedPage });
  }

  return <article className="run-review" data-advanced={advanced} aria-labelledby="review-editor-title">
    <h3 id="review-editor-title">{fieldName(field)}</h3>
    {draft && <p className="review-confirmed">Confirmed for this review · {draft.value} · Page {draft.page}</p>}
    <p>{conflicting ? `The readings disagree on ${fieldName(field).toLowerCase()}. Compare each value with its page in the original policy.`
      : field === "policy_type" ? "Copy the full policy title from the policy schedule."
      : field === "insurer" ? "Use the current insurer named in the policy schedule."
      : field === "rto" ? "Enter the RTO code from the vehicle registration, such as MH01."
      : field === "fuel" ? "Use the fuel type printed in the vehicle details."
      : field === "engine_cc" ? "Use the cubic capacity printed in the vehicle details, in cc."
      : "Enter the value shown in the original policy."}</p>
    <form onSubmit={confirm} className="review-confirmation">
      {conflicting && <div className="review-readings">
        {groups.map((sources, index) => <section key={index} data-reader={index + 1}>
          <h4>Reading {index + 1}</h4>
          <ul>{sources.map(source => <li key={source.raw}>
            <mark>{source.raw}</mark>
            {source.quote && source.quote !== source.raw && <blockquote>{source.quote}</blockquote>}
            <div className="reading-actions">
              <button className="button secondary" type="button" onClick={() => openPage(source.page!, source)}
                disabled={!pages || source.page! > pages || working}>View page {source.page}</button>
              <button className="button secondary" type="button"
                onClick={() => { setValue(source.raw ?? ""); setCustom(true); setError(""); openPage(source.page!, source); }}
                disabled={!pages || source.page! > pages || working || Boolean(confirmationError(field, source.raw!))}>
                Use reading {index + 1}
              </button>
            </div>
            {!source.box && <small>Page cited · exact region unavailable</small>}
          </li>)}</ul>
        </section>)}
        {groups.length === 1 && <section><h4>Reading 2</h4><p>No independent value to compare.</p></section>}
      </div>}
      {conflicting && <button type="button" className="button secondary" aria-pressed={custom} disabled={working}
        onClick={() => { setCustom(true); setError(""); requestAnimationFrame(() => input.current?.focus()); }}>
        Enter a custom value
      </button>}
      {!conflicting && suggestion?.page && suggestion.page <= pages && <button type="button" className="button secondary"
        disabled={working} onClick={() => {
          setValue(suggestion.raw ?? ""); setError(""); openPage(suggestion.page!, suggestion);
        }}>Use suggested value · {suggestion.raw}</button>}
      {custom && <label>Value from the policy
        <input ref={input} value={value} onChange={event => { setValue(event.target.value); setError(""); }}
          maxLength={220} required disabled={working} />
      </label>}
      {custom && field.endsWith("_date") && <p>Use YYYY-MM-DD.</p>}
      {citedPage && <p>Source · page {citedPage}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="button primary" disabled={working || !answer || !citedPage || citedPage > pages}>
        {draft ? "Update confirmation" : "Confirm value"}
      </button>
    </form>
  </article>;
}

function ReviewDesk({ fields, required, conflicts, drafts, report, run, pdf, working, onDraft, onConfirm, onClose }: {
  fields: string[];
  required: readonly string[];
  conflicts: readonly string[];
  drafts: Record<string, Clarification>;
  onDraft: (answer: Clarification) => void;
  report: Report;
  run: Run;
  pdf: string;
  working: boolean;
  onConfirm: (value: ReviewSubmission) => Promise<void>;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState(fields[0]);
  const [page, setPage] = useState(() => drafts[fields[0]]?.page ?? report.fields[fields[0]]?.evidence.find(source => source.page)?.page ?? 1);
  const [target, setTarget] = useState<Source>();
  const [error, setError] = useState("");
  const [pages, setPages] = useState(0);
  const [retry, setRetry] = useState(0);
  const [pageError, setPageError] = useState(false);
  const [badImage, setBadImage] = useState<number>();
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [ready, setReady] = useState(false);
  const [lastConfirmed, setLastConfirmed] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const viewer = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const recalculate = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const queue = [...new Set([...fields, ...Object.keys(drafts), ...discovered])];
  const field = queue.includes(selection) ? selection : queue[0];
  const pending = [...new Set([...required, ...discovered])].filter(name => !drafts[name]);
  const busy = working || checking;
  const answers = Object.values(drafts);
  const annotations = conflicts.includes(field) ? readingGroups(report.fields[field]?.evidence ?? []) : [];
  const currentPage = pages ? Math.min(page, pages) : page;
  const url = `/api/runs/${run.id}/pages`;

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    picker.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!Number.isInteger(data.pages) || data.pages < 1 || data.pages > 60) throw new Error();
        if (!controller.signal.aborted) setPages(data.pages);
      })
      .catch(() => { if (!controller.signal.aborted) setPageError(true); });
    return () => controller.abort();
  }, [url, retry]);

  function scrollToRegion(source = target) {
    if (!source?.box || !canvas.current || !viewer.current) return;
    const bar = viewer.current.querySelector<HTMLElement>(".review-pdf-bar");
    viewer.current.scrollTo({ top: canvas.current.offsetTop + source.box[1] * canvas.current.offsetHeight - (bar?.offsetHeight ?? 0) - 28 });
  }

  function openPage(next: number, source?: Source) {
    if (next === currentPage && source?.box) scrollToRegion(source);
    else viewer.current?.scrollTo({ top: 0 });
    setBadImage(undefined);
    setTarget(source);
    setPage(next);
  }

  function selectField(next: string) {
    setSelection(next);
    openPage(drafts[next]?.page ?? report.fields[next]?.evidence.find(source => source.page)?.page ?? 1);
  }

  async function checkRemaining(confirmations = answers) {
    setError("");
    setChecking(true);
    try {
      const response = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmations, revision: run.revision, preview: true }),
      });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.remaining)) {
        throw new Error(result.error || "Could not check the remaining details.");
      }
      const next = result.remaining as string[];
      setDiscovered(next);
      if (next.length) {
        selectField(next[0]);
        requestAnimationFrame(() => picker.current?.focus());
        return;
      }
      setReady(true);
      requestAnimationFrame(() => recalculate.current?.focus());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not check the remaining details.");
    } finally {
      setChecking(false);
    }
  }

  function confirm(answer: Clarification) {
    onDraft(answer);
    setReady(false);
    setLastConfirmed(fieldName(answer.field));
    const outstanding = drafts[answer.field] ? required.filter(name => !drafts[name]) : pending;
    const next = outstanding.find(name => name !== answer.field);
    if (next) {
      selectField(next);
      picker.current?.focus();
      return;
    }
    void checkRemaining(Object.values({ ...drafts, [answer.field]: answer }));
  }

  async function submit() {
    if (!ready || pending.length || !answers.length || busy) return;
    setError("");
    try {
      await onConfirm({ confirmations: answers, revision: run.revision, guided: true });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the review. Try again.");
    }
  }

  return <dialog ref={dialog} className="review-desk" aria-labelledby="review-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault(); }}>
    <header className="review-header">
      <div><h2 id="review-title">{conflicts.length ? "Resolve OCR conflicts" : "Verify policy details"}</h2>
        <p>{run.display_name || run.filename}</p></div>
      <button className="button secondary" type="button" disabled={busy} onClick={() => dialog.current?.close()}>
        Back to report
      </button>
    </header>
    <div className="review-layout">
      <section ref={viewer} className="review-pdf" tabIndex={0} aria-labelledby="review-pdf-title">
        <div className="review-pdf-bar">
          <h3 id="review-pdf-title">Original policy</h3>
          {pages > 0 && <label>Page
            <select value={currentPage} onChange={event => openPage(Number(event.target.value))} disabled={busy}>
              {Array.from({length: pages}, (_, index) => <option key={index} value={index + 1}>{index + 1} of {pages}</option>)}
            </select>
          </label>}
          <a href={`${pdf}#page=${currentPage}`} target="_blank" rel="noreferrer">Open full PDF</a>
        </div>
        {pageError ? <div className="review-pdf-status">
          <p>Could not load the policy pages.</p>
          <button type="button" className="button secondary" onClick={() => { setPageError(false); setRetry(n => n + 1); }}>Try again</button>
        </div> : pages === 0 ? <p className="review-pdf-status" role="status">Loading policy pages…</p>
          : badImage === currentPage ? <p className="review-pdf-status">Preview unavailable. Open the original PDF to read this page.</p>
          : <div ref={canvas} className="review-page">
            <Image key={currentPage} src={`${url}?page=${currentPage}`} unoptimized height={2048} width={1448}
              alt={`Page ${currentPage} of ${run.filename}`} onLoad={() => scrollToRegion()} onError={() => setBadImage(currentPage)} />
            {annotations.flatMap((sources, group) => sources.map((source, index) => {
              if (source.page !== currentPage || !source.box) return null;
              const [left, top, right, bottom] = source.box;
              if (!(left >= 0 && left < right && right <= 1 && top >= 0 && top < bottom && bottom <= 1)) return null;
              return <span key={`${group}-${index}`} className="review-region" data-reader={group + 1}
                data-active={target === source} aria-hidden="true"
                style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%` }}>
                <span>Reading {group + 1}</span>
              </span>;
            }))}
          </div>}
      </section>
      <div className="review-editor">
        <label className="review-field-picker">Field to review
          <select ref={picker} value={field} disabled={busy} onChange={event => selectField(event.target.value)}>
            {queue.map(name => <option key={name} value={name}>{fieldName(name)}{drafts[name] ? " · Confirmed" : ""}</option>)}
          </select>
        </label>
        <ConfirmField key={field} field={field} fact={report.fields[field]} page={currentPage} openPage={openPage} pages={pages}
          draft={drafts[field]} conflicting={conflicts.includes(field)} working={busy} advanced={Boolean(lastConfirmed)} onConfirm={confirm} />
      </div>
    </div>
    <footer className="review-footer">
      <div>
        <p role="status">
          {lastConfirmed && <strong key={lastConfirmed} className="review-step-done">{lastConfirmed} confirmed. </strong>}
          {working ? "Recalculating commission…" : checking ? "Checking what’s still needed…" : ready ? "Ready to recalculate."
            : pending.length === 1 ? "One detail remaining." : pending.length ? `${pending.length} details remaining.` : ""}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      {!ready && !pending.length && answers.length > 0 && !checking && <button type="button" className="button secondary"
        onClick={() => void checkRemaining()}>Check remaining details</button>}
      <button ref={recalculate} type="button" className="button primary" disabled={busy || !ready || !answers.length || pending.length > 0} onClick={submit}>
        {working && <span className="review-spinner" aria-hidden="true" />}
        {working ? "Recalculating…" : "Recalculate commission"}
      </button>
    </footer>
  </dialog>;
}

function Commission({ label, abbreviation, part, sharedReason }: {
  label: string; abbreviation: string; part: Rate; sharedReason: boolean;
}) {
  const rate = part.rate != null ? runRateLabel(part.rate) : part.applicable === false
    ? "Inapplicable" : part.status === "unsupported" ? "Unsupported" : "Undetermined";
  return <div className="run-coverage" data-status={part.status}>
    <dt><span className="run-coverage-code">{abbreviation}</span>{label}</dt>
    <dd>
      <strong className={part.rate != null ? "run-rate run-rate-numeric" : "run-rate"}>{rate}</strong>
      {!sharedReason && <p>{part.reason}</p>}
    </dd>
  </div>;
}

function Facts({ entries, pdf, filename }: { entries: [string, Fact][]; pdf: string; filename: string }) {
  return <dl className="run-fact-list">{entries.map(([field, fact]) => <div key={field} className="run-fact">
    <dt>{fieldName(field)}</dt>
    <dd>
      {fact.value != null ? <strong>{fact.value}</strong> : factReason(fact.reason)}
      {fact.confirmation && <p className="run-source-note">Reviewer confirmed on <Citation source={{ file: filename, page: fact.confirmation.page }} pdf={pdf} /></p>}
      <Sources items={fact.evidence} pdf={pdf} />
    </dd>
  </div>)}</dl>;
}

function Trace({ steps, pdf }: { steps: Report["trace"]; pdf: string }) {
  return <ol className="run-trace" role="list">{steps.map((step, index) => <li key={index}>
    <span aria-hidden="true" className="run-trace-index">{index + 1}</span>
    <div>
      <p>{step.step}</p>
      <Sources items={step.sources} pdf={pdf} />
    </div>
  </li>)}</ol>;
}

type Panel = "trace" | "facts";

function AnalysisProgress({ progress }: { progress: Run["ocr_progress"] }) {
  const [motionPaused, setMotionPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  const rating = progress && progress.completed === progress.total;
  const title = rating ? "Checking commission rates" : "Reading the policy";
  const status = progress
    ? `${progress.completed} of ${progress.total} ${progress.total === 1 ? "page" : "pages"} checked`
    : "Preparing pages for analysis";
  const stages = ["PDF saved", "Check policy pages", "Calculate commission"];
  const currentStage = rating ? 2 : 1;

  return <section className="analysis-progress" aria-labelledby="analysis-progress-title">
    <div className="analysis-status">
      <Image className="run-processing-mark" src={motionPaused || reducedMotion ? stillMonogram : processingMonogram}
        alt="" width={76} height={76} unoptimized loading="eager" />
      <div>
        <h2 id="analysis-progress-title">{title}</h2>
        <p role="status">{status}</p>
      </div>
    </div>
    <progress className="run-progress" aria-label="Policy pages checked"
      value={progress?.completed} max={progress?.total} />
    <ol className="analysis-stages" aria-label="Analysis steps">
      {stages.map((stage, index) => <li key={stage} aria-current={index === currentStage ? "step" : undefined}
        data-complete={index < currentStage}>
        <span className="analysis-stage-mark" aria-hidden="true" />
        {index < currentStage && <span className="sr-only">Complete. </span>}
        {stage}
      </li>)}
    </ol>
    <footer className="analysis-footer">
      <p>You can open another run. This analysis continues in the background.</p>
      <button type="button" className="analysis-motion-control" onClick={() => setMotionPaused(paused => !paused)}>
        {motionPaused ? "Resume logo animation" : "Pause logo animation"}
      </button>
    </footer>
  </section>;
}

export function RunResult({ run, working, processing, onProcess, onConfirm }: {
  run: Run;
  working: boolean;
  processing: boolean;
  onProcess: () => Promise<void>;
  onConfirm: (value: ReviewSubmission) => Promise<void>;
}) {
  const baseId = useId();
  const [panel, setPanel] = useState<Panel>("trace");
  const tabButtons = useRef<Partial<Record<Panel, HTMLButtonElement>>>({});
  const pdf = `/api/runs/${run.id}/pdf`;
  const report = run.result;
  const pending = run.status === "processing" && Date.parse(run.lease_until ?? "") > Date.now();
  const analyzing = processing || pending;
  const status = report?.status ?? (analyzing ? "processing" : run.status === "processing" ? "failed" : run.status);
  const notice = readerNotice(report?.reader_failures);
  const facts = Object.entries(report?.fields ?? {});
  const confirmed = facts.filter(([, fact]) => fact.value != null);

  const reviewable = report && !run.deleting_at ? reviewFields(report) : [];
  const conflicts = report && !run.deleting_at ? conflictFields(report) : [];
  const required = report && !run.deleting_at ? requiredReviewFields(report) : [];
  const extraEvidence = facts.filter(([field, fact]) => fact.value == null && fact.evidence.length > 0 && !required.includes(field));
  const optional = reviewable.filter(field => !required.includes(field));
  const traceStart = report?.rating_trace_start ?? 0;
  const decisions = report?.trace.slice(traceStart) ?? [];
  const policyTrace = report?.trace.slice(0, traceStart) ?? [];
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Clarification>>({});
  const [confirmationMessage, setConfirmationMessage] = useState("");
  const reviewAction = conflicts.length ? "Resolve OCR conflicts" : "Verify policy details";

  function openReview(field?: string) {
    setConfirmationMessage("");
    setReviewQueue([...new Set([...(field ? [field] : []), ...required, ...Object.keys(drafts)])]);
  }

  const tabs: { id: Panel; text: string; count: number }[] = [
    { id: "trace", text: "Decision trace", count: decisions.length },
    { id: "facts", text: "Policy facts", count: confirmed.length },
  ];
  const activePanel = panel;
  const sharedReason = Boolean(report?.od.reason && report.od.reason === report.tp.reason);

  function activateTab(id: Panel) {
    setPanel(id);
    tabButtons.current[id]?.focus();
  }

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex(tab => tab.id === activePanel);
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (current + 1) % tabs.length; break;
      case "ArrowLeft": next = (current + tabs.length - 1) % tabs.length; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    activateTab(tabs[next].id);
  }

  return <section id="result" className="run-report" aria-labelledby="result-title" tabIndex={-1}>
    <header className="run-head">
      <div className="run-heading">
        <h1 id="result-title">{run.display_name || run.filename}</h1>
        {run.display_name && <p className="run-original-name">{run.filename}</p>}
        <p className="run-state" role="status"><RunStatus status={run.deleting_at ? "deleting" : status} /></p>
      </div>
      {!run.deleting_at && <a className="button secondary run-open-original" href={pdf} target="_blank" rel="noreferrer" aria-label="Open original PDF in a new tab">
        Open original PDF
      </a>}
    </header>
    {report ? <>
      <section aria-labelledby="commission-title" className="run-outcome">
        <h2 id="commission-title">Broker commission</h2>
        <dl className="run-coverage-grid">
          <Commission label="Own damage" abbreviation="OD" part={report.od} sharedReason={sharedReason} />
          <Commission label="Third party" abbreviation="TP" part={report.tp} sharedReason={sharedReason} />
        </dl>
        {sharedReason && <p className="run-shared-reason">{report.od.reason}</p>}
        <div className="run-confidence">
          <p><strong>{report.confidence.level} confidence.</strong> {report.confidence.reason}</p>
          {decisions.length > 0 && <button type="button" className="run-evidence-link" onClick={() => {
            activateTab("trace");
            tabButtons.current.trace?.scrollIntoView({ block: "start" });
          }}>View decision evidence</button>}
        </div>
      </section>
      {confirmationMessage && <p className="review-confirmed" role="status">{confirmationMessage}</p>}
      {required.length > 0 && <section className="run-review-prompt" aria-labelledby="required-review-title">
        <header>
          <div>
            <h2 id="required-review-title">{required.length === 1 ? "One policy detail to review" : `${required.length} policy details to review`}</h2>
            <p>Check these details against the original PDF.</p>
          </div>
          <button type="button" className="button primary" onClick={() => openReview()}>{reviewAction}</button>
        </header>
        <ul>
          {required.map(field => {
            const fact = report.fields[field];
            const pages = [...new Set(fact?.evidence.flatMap(source => source.page ? [source.page] : []) ?? [])];
            return <li key={field}>
              <button type="button" className="run-review-field" onClick={() => openReview(field)}>
                {fieldName(field)}
              </button>
              <p>{factReason(fact?.reason ?? "")}</p>
              {pages.length > 0 && <div className="run-citation-links">
                {pages.map(page => <Citation key={page} source={{ file: run.filename, page }} pdf={pdf} />)}
              </div>}
            </li>;
          })}
        </ul>
      </section>}
      {notice && <details className="run-notice">
        <summary>OCR details</summary>
        <p>{notice}</p>
      </details>}
      {reviewQueue.length > 0 && <ReviewDesk key={run.revision} fields={reviewQueue} required={required} conflicts={conflicts} drafts={drafts}
        report={report} run={run} pdf={pdf} working={working} onDraft={answer => setDrafts(current => ({ ...current, [answer.field]: answer }))}
        onClose={() => setReviewQueue([])} onConfirm={async value => {
          await onConfirm(value);
          setDrafts({});
          setReviewQueue([]);
          setConfirmationMessage("Review saved. Commission recalculated.");
          requestAnimationFrame(() => document.getElementById("result")?.focus());
        }} />}


      <div className="run-evidence">
        <div className="run-tabs" role="tablist" aria-label="Analysis details" onKeyDown={navigateTabs}>
          {tabs.map(({ id, text, count }) => <button key={id} type="button" role="tab"
            ref={button => { if (button) tabButtons.current[id] = button; else delete tabButtons.current[id]; }}
            id={`${baseId}-${id}-tab`} aria-controls={`${baseId}-${id}`} aria-selected={activePanel === id}
            tabIndex={activePanel === id ? 0 : -1} onClick={() => setPanel(id)}>
            {text}{count > 0 && <span className="run-tab-count" aria-hidden="true">{count}</span>}
          </button>)}
        </div>
        {tabs.map(({ id }) => <div className="run-pane" key={id} id={`${baseId}-${id}`}
          role="tabpanel" aria-labelledby={`${baseId}-${id}-tab`} tabIndex={0} hidden={activePanel !== id}>
          {activePanel === id && (id === "trace" ? <>
            {decisions.length ? <Trace steps={decisions} pdf={pdf} /> :
              <p className="run-empty">A rate-card lookup needs verified policy facts. Check the Policy facts tab for fields that could not be read.</p>}
            {policyTrace.length > 0 && <details className="run-unverified">
              <summary>Verified policy inputs</summary>
              <Trace steps={policyTrace} pdf={pdf} />
            </details>}
            {report.rule_version && <p className="run-source-note">Rate-card version {report.rule_version}</p>}
          </> : <>
            {confirmed.length > 0
              ? <Facts entries={confirmed} pdf={pdf} filename={run.filename} />
              : <p className="run-empty">No policy facts could be verified for this run.</p>}
            {extraEvidence.length > 0 && <details className="run-unverified">
              <summary>Other unverified readings <span aria-hidden="true">({extraEvidence.length})</span></summary>
              <p>Argus excluded these readings from the rate lookup. Any fields you need to review are listed above.</p>
              <Facts entries={extraEvidence} pdf={pdf} filename={run.filename} />
            </details>}
            {report.status === "ambiguous" && optional.length > 0 && <button type="button" className="button secondary run-fact-action"
              onClick={() => setReviewQueue([...optional, ...required])}>Add another policy detail</button>}
          </>)}
        </div>)}
      </div>
    </> : analyzing ? <AnalysisProgress progress={run.ocr_progress} /> : <div className="run-job">
      <div>
        <p>{run.error || "The original PDF is saved. You can resume analysis from this run."}</p>
        {run.status !== "complete" && <button type="button" className="button primary" onClick={onProcess} disabled={working}>
          {status === "failed" ? "Retry analysis" : "Resume analysis"}
        </button>}
      </div>
    </div>}
  </section>;
}
