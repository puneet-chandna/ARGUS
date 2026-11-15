"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import monogram from "./argus-monogram.svg";
import type { DragEvent, FormEvent } from "react";
import type { OcrMode } from "../lib/ocr-status";
import { ocrDescription } from "./ocr";
import { labels, RunResult } from "./report";
import { AuthEntry, Landing } from "./landing";
import { RunSettings } from "./run-settings";
import "./desk.css";
import type { ReviewSubmission, Run } from "./report";

type Session = { email: string };
type Signup = Session | { confirmationRequired: true };

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(typeof data?.error === "string" ? data.error : "The request could not be completed.", response.status);
  }
  return data as T;
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

function message(error: unknown): string {
  return error instanceof RequestError ? error.message : "Could not connect to Argus. Try again.";
}

type View = "landing" | "signin" | "workspace";
const RUN_LINK = /^#[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function showPath(path: string) {
  const hash = RUN_LINK.test(window.location.hash) ? window.location.hash : "";
  if (window.location.pathname !== path || window.location.search) {
    window.history.replaceState(null, "", path + hash);
  }
}

export default function Argus({ initialView }: { initialView: View }) {
  const [view, setView] = useState(initialView);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [error, setError] = useState("");
  const gateHeading = useRef<HTMLHeadingElement>(null);
  const main = useRef<HTMLElement>(null);
  const moveAuthFocus = useRef(false);
  const credentialsSubmitted = useRef(false);
  const creatingAccount = authMode === "signup";

  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(window.location.href);
    let start = initialView;
    if (url.searchParams.get("view") === "signin" || url.searchParams.get("auth") === "confirmation_failed") start = "signin";
    else if (initialView === "landing" && RUN_LINK.test(url.hash)) start = "workspace";
    if (url.searchParams.get("auth") === "confirmation_failed") {
      setError("The confirmation link could not be used. If you already confirmed your email, sign in.");
      showPath("/sign-in");
    }
    setView(start);
    api<Session>("/api/session", { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || credentialsSubmitted.current) return;
      setSession(result);
      if (start !== "landing") {
        setView("workspace");
        showPath("/workspace");
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || credentialsSubmitted.current) return;
      if (!(error instanceof RequestError && error.status === 401)) setError(message(error));
      setSession(null);
      if (start !== "landing") {
        setView("signin");
        showPath("/sign-in");
      }
    });
    return () => controller.abort();
  }, [initialView]);

  useEffect(() => {
    if (!moveAuthFocus.current) return;
    moveAuthFocus.current = false;
    if (view === "workspace" && session) main.current?.focus();
    else gateHeading.current?.focus();
  }, [session, authMode, confirmationEmail, view]);

  function switchAuthMode() {
    moveAuthFocus.current = true;
    setAuthMode(confirmationEmail || creatingAccount ? "signin" : "signup");
    setConfirmationEmail("");
    setError("");
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const address = String(data.get("email") ?? "").trim();
    credentialsSubmitted.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<Signup>(creatingAccount ? "/api/signup" : "/api/session",
        json("POST", { email: address, password: data.get("password") }));
      moveAuthFocus.current = true;
      if ("confirmationRequired" in result) {
        setEmail(address);
        setConfirmationEmail(address);
      } else {
        setHandoff(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        showPath("/workspace");
        setSession(result);
        setView("workspace");
        setAuthMode("signin");
        setEmail("");
      }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await api("/api/session", { method: "DELETE" });
      moveAuthFocus.current = true;
      setHandoff(false);
      setSession(null);
      setView("signin");
      showPath("/sign-in");
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  function expireSession() {
    moveAuthFocus.current = true;
    setHandoff(false);
    setSession(null);
    setView("signin");
    showPath("/sign-in");
    setError("Your session expired. Sign in to reopen your runs.");
  }

  const isWorkspace = view === "workspace";
  return <div className="app-frame" data-view={view}>
    <a className="skip-link" href={isWorkspace && session ? "#work" : "#main"} onClick={event => {
      if (isWorkspace && session) {
        event.preventDefault();
        document.getElementById("work")?.focus();
      }
    }}>Skip to main content</a>
    <header className="masthead" data-view={view}>
      <a href={isWorkspace ? "/workspace" : "/"} className="brand" aria-label={isWorkspace ? "Argus workspace" : "Argus home"}>
        <Image src={monogram} alt="" width={40} height={40} unoptimized />
        Argus
      </a>
      {isWorkspace ? <>
        <span className="product">Review workspace</span>
        {session && <div className="account">
          <span>{session.email}</span>
          <button type="button" className="button secondary" onClick={signOut} disabled={busy}>Sign out</button>
        </div>}
      </> : view === "landing" && <nav className="site-nav" aria-label="Primary">
        <a href="#worked-example">Example decision</a>
        <a href={session ? "/workspace" : "/sign-in"} className="button secondary">{session ? "Open workspace" : "Sign in"}</a>
      </nav>}
    </header>
    {handoff && <div className="auth-handoff" aria-hidden="true" onAnimationEnd={event => {
      if (event.target === event.currentTarget) setHandoff(false);
    }}>
      <Image src={`${monogram.src}?signin`} alt="" width={96} height={96} unoptimized loading="eager" />
    </div>}
    <main ref={main} id="main" className="shell" tabIndex={-1}>
      {view === "landing" ? <Landing /> : isWorkspace ?
        session ? <Workspace key={session.email} onUnauthorized={expireSession} sessionError={error} /> :
          <p className="loading session-loading" role="status">Opening your workspace…</p> :
        <AuthEntry creatingAccount={creatingAccount} confirmationEmail={confirmationEmail} email={email}
          busy={busy} error={error} headingRef={gateHeading} onEmail={setEmail} onSubmit={authenticate} onSwitch={switchAuthMode} />}
    </main>
  </div>;
}

function Workspace({ onUnauthorized, sessionError }: { onUnauthorized: () => void; sessionError: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [ocr, setOcr] = useState<OcrMode>();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [restart, setRestart] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [managed, setManaged] = useState<Run>();
  const removedRuns = useRef(new Set<string>());
  const [active, setActive] = useState<{ id: string } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [working, setWorking] = useState(false);
  const [processingId, setProcessingId] = useState<string>();
  const [error, setError] = useState("");
  const selected = useRef("");
  const focusRequested = useRef("");
  const pendingUpload = useRef<{ file: File; allowCloud: boolean; key: string } | null>(null);
  const live = useRef(false);
  const onAuthError = useRef(onUnauthorized);

  useEffect(() => { onAuthError.current = onUnauthorized; }, [onUnauthorized]);

  function fail(error: unknown) {
    if (!live.current) return;
    if (error instanceof RequestError && error.status === 401) onAuthError.current();
    else setError(message(error));
  }

  function record(next: Run) {
    if (!live.current || removedRuns.current.has(next.id)) return;
    if (selected.current === next.id) {
      setRun((previous) => previous?.id === next.id && previous.revision > next.revision ? previous : next);
    }
    setRuns((previous) => {
      const existing = previous.find((saved) => saved.id === next.id);
      if (existing?.revision != null && existing.revision > next.revision) return previous;
      if (existing) return previous.map((saved) => saved.id === next.id ? next : saved);
      return [next, ...previous];
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    live.current = true;
    const id = window.location.hash.slice(1);
    if (RUN_LINK.test(window.location.hash)) {
      selected.current = id;
      setActive({ id });
    }
    api<{ runs: Run[]; ocr: OcrMode }>("/api/runs", { signal: controller.signal }).then(({ runs, ocr }) => {
      if (controller.signal.aborted) return;
      setRuns((current) => {
        const byId = new Map(runs.filter(saved => !removedRuns.current.has(saved.id)).map(saved => [saved.id, saved]));
        for (const saved of current) if ((byId.get(saved.id)?.revision ?? -1) <= saved.revision) byId.set(saved.id, saved);
        return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
      setOcr(ocr);
      setHistoryLoaded(true);
    }).catch((error: unknown) => { if (!controller.signal.aborted) { fail(error); setHistoryLoaded(true); } });
    return () => { live.current = false; controller.abort(); };
  }, [restart]);

  useEffect(() => {
    if (!active) return;
    const { id } = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function refresh() {
      try {
        const { run } = await api<{ run: Run }>(`/api/runs/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        record(run);
        if (run.status === "queued" || (run.status === "processing" && Date.parse(run.lease_until ?? "") > Date.now())) {
          timer = setTimeout(refresh, 2500);
        }
      } catch (error) { if (!controller.signal.aborted) fail(error); }
    }
    void refresh();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active]);

  useEffect(() => {
    if (run && focusRequested.current === run.id) {
      focusRequested.current = "";
      document.getElementById("result")?.focus();
    } else if (!active && focusRequested.current === "intake") {
      focusRequested.current = "";
      document.getElementById("workspace-title")?.focus();
    }
  }, [active, run]);

  function select(id: string) {
    setHistoryOpen(false);
    if (selected.current !== id) setRun(null);
    selected.current = id;
    focusRequested.current = id;
    setActive({ id });
    window.history.replaceState(null, "", `#${id}`);
  }

  async function process(id: string) {
    setProcessingId(id);
    try {
      const { run } = await api<{ run: Run }>(`/api/runs/${id}`, { method: "POST" });
      record(run);
    } finally {
      if (live.current) setProcessingId(undefined);
    }
  }

  async function action(task: () => Promise<void>) {
    setWorking(true);
    setError("");
    try { await task(); }
    catch (error) { fail(error); }
    finally { if (live.current) setWorking(false); }
  }

  function chooseFile(next: File | null) {
    if (!next) return;
    if ((!next.name.toLowerCase().endsWith(".pdf") && next.type !== "application/pdf") ||
      !next.size || next.size > 20 * 1024 * 1024) {
      if (picker.current) picker.current.value = "";
      setFile(null);
      setError("Choose a nonempty PDF up to 20 MiB.");
      return;
    }
    setFile(next);
    setError("");
  }

  function dropFile(event: DragEvent<HTMLLabelElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    if (working) return;
    if (event.dataTransfer.files.length !== 1) {
      setError("Drop one PDF at a time.");
      return;
    }
    if (picker.current) picker.current.value = "";
    chooseFile(event.dataTransfer.files[0]);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) {
      setError("Choose a PDF to analyze.");
      picker.current?.focus();
      return;
    }
    const data = new FormData(form);
    data.set("pdf", file);
    const allowCloud = ocr?.live === "ready" && data.get("allowCloud") === "true";
    if (!allowCloud) data.delete("allowCloud");
    if (pendingUpload.current?.file !== file || pendingUpload.current.allowCloud !== allowCloud) {
      pendingUpload.current = { file, allowCloud, key: crypto.randomUUID() };
    }
    const key = pendingUpload.current.key;
    await action(async () => {
      const { run } = await api<{ run: Run }>("/api/runs", {
        method: "POST", body: data, headers: { "Idempotency-Key": key },
      });
      if (!live.current) return;
      pendingUpload.current = null;
      form.reset();
      setFile(null);
      select(run.id);
      record(run);
      if (run.status === "queued") await process(run.id);
    });
  }

  async function confirm(id: string, value: ReviewSubmission) {
    setWorking(true);
    setError("");
    try {
      const { run } = await api<{ run: Run }>(`/api/runs/${id}`, json("PATCH", value));
      record(run);
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) {
        const { run } = await api<{ run: Run }>(`/api/runs/${id}`);
        record(run);
      }
      if (error instanceof RequestError && error.status === 401) fail(error);
      throw error;
    } finally {
      if (live.current) setWorking(false);
    }
  }

  function newAnalysis() {
    selected.current = "";
    setHistoryOpen(false);
    focusRequested.current = active ? "intake" : "";
    setActive(null);
    setRun(null);
    setError("");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!active) document.getElementById("workspace-title")?.focus();
  }

  const availability = ocr && ocrDescription(ocr);
  const query = historyQuery.trim().toLowerCase();
  const visibleRuns = runs.filter(item => {
    const status = item.decision ?? item.result?.status ?? item.status;
    return (item.filename.toLowerCase().includes(query) || item.display_name?.toLowerCase().includes(query)) &&
      (decisionFilter === "all" || status === decisionFilter);
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.created_at.localeCompare(a.created_at));
  const dateTime = (value: string) => new Date(value).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return <div className="workspace">
    <div className="desk-mobile">
      <button className="button secondary" type="button" aria-expanded={historyOpen} aria-controls="history"
        onClick={() => setHistoryOpen(open => !open)}>{historyOpen ? "Hide saved runs" : "Saved runs"}</button>
      <button className="button primary" type="button" onClick={newAnalysis}>New analysis</button>
    </div>
    <aside className="history" id="history" data-open={historyOpen} aria-labelledby="history-title" tabIndex={-1}>
      <div className="history-top">
        <h2 id="history-title">Saved runs</h2>
        <button className="button primary" type="button" onClick={newAnalysis}>New analysis</button>
      </div>
      {runs.length > 0 && <div className="history-controls">
        <label>Search saved runs
          <input type="search" value={historyQuery} placeholder="Policy filename"
            onChange={event => setHistoryQuery(event.target.value)} />
        </label>
        <label>Decision
          <select value={decisionFilter} onChange={event => setDecisionFilter(event.target.value)}>
            <option value="all">All decisions</option>
            <option value="ambiguous">Needs review</option>
            <option value="resolved">Resolved</option>
            <option value="unsupported">Unsupported</option>
          </select>
        </label>
      </div>}
      {visibleRuns.length > 0 ? <ul className="history-list" tabIndex={0} aria-label="Saved policy runs">{visibleRuns.map(item => {
        const status = item.decision ?? item.result?.status ?? item.status;
        const title = item.display_name || item.filename;
        const activeJob = item.status === "processing" && Date.parse(item.lease_until ?? "") > Date.now();
        return <li key={item.id} className="history-row" data-current={active?.id === item.id}>
          <button className="history-item" type="button" aria-current={active?.id === item.id ? "true" : undefined}
            onClick={() => { setError(""); select(item.id); }}>
            <strong>{title}</strong>
            <span className="run-meta"><span className={`state ${status}`}>{item.deleting_at ? "Deletion pending" : labels[status]}</span>
              <time dateTime={item.created_at}>{dateTime(item.created_at)}</time>
              {item.pinned && <span className="run-pin">Pinned</span>}
            </span>
          </button>
          <button type="button" className="history-manage" aria-label={`Manage ${title}, ${dateTime(item.created_at)}`}
            disabled={activeJob} onClick={() => setManaged(item)}><span aria-hidden="true">⋯</span></button>
        </li>;
      })}</ul> : <p className="history-empty" role="status">{runs.length ? "No runs match this filter." :
        historyLoaded ? (ocr ? "Your first analysis will appear here." : "Saved runs are unavailable.") : "Loading saved runs…"}</p>}
    </aside>
    <div className="work" id="work" tabIndex={-1}>
      {(error || sessionError) && <div className="error workspace-error">
        <p role="alert">{error || sessionError}</p>
        {!ocr && error && <button className="button secondary" type="button" onClick={() => {
          setError("");
          setHistoryLoaded(false);
          setRestart(n => n + 1);
        }}>Reload workspace</button>}
      </div>}
      {managed && <RunSettings key={managed.id} run={managed} onClose={() => setManaged(undefined)}
        onSave={async (displayName, pinned) => {
          const { run } = await api<{ run: Run }>(`/api/runs/${managed.id}`,
            json("PATCH", { displayName, pinned, revision: managed.revision }));
          record(run);
        }}
        onDelete={async () => {
          await api(`/api/runs/${managed.id}`, json("DELETE", { confirm: true }));
          removedRuns.current.add(managed.id);
          setRuns(current => current.filter(item => item.id !== managed.id));
          if (selected.current === managed.id) newAnalysis();
          else document.getElementById("history")?.focus();
        }} />}
      {run ? <RunResult key={run.id} run={run} working={working} processing={processingId === run.id}
        onProcess={() => action(() => process(run.id))} onConfirm={(value) => confirm(run.id, value)} /> :
        active && !error ? <p className="loading" role="status">Opening saved run…</p> :
        <section className="intake" aria-labelledby="workspace-title">
          <header className="intake-heading">
            <h1 id="workspace-title" tabIndex={-1}>New analysis</h1>
            <p>Check own damage and third-party commission against the insurer’s rate card.</p>
          </header>
          <form className="upload" onSubmit={upload} aria-busy={working}>
            <label className="file-control" htmlFor="policy-pdf" data-dragging={dragging} data-selected={Boolean(file)}
              onDragOver={event => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = working ? "none" : "copy";
                if (!working) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)} onDrop={dropFile}>
              <input ref={picker} id="policy-pdf" name="pdf" type="file" accept=".pdf,application/pdf"
                aria-labelledby="pdf-picker-label" aria-describedby="pdf-limit pdf-selection" disabled={working}
                onChange={event => chooseFile(event.target.files?.[0] ?? null)} />
              <svg className="file-mark" viewBox="0 0 32 36" width="32" height="36" aria-hidden="true" focusable="false">
                <path d="M6 2h13l7 7v23a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm13 0v7h7" />
                {file ? <path d="m10 21 4 4 7-8" /> : <path d="M10 17h10m-10 6h7" />}
              </svg>
              <span className="file-copy" aria-live="polite" aria-atomic="true">
                <strong className="file-title" id="pdf-selection">{file?.name ?? "Drop a motor policy PDF here"}</strong>
                <span className="file-limit" id="pdf-limit">{file ? `${Math.max(1, Math.ceil(file.size / 1024)).toLocaleString()} KiB` : "PDF up to 20 MiB"}</span>
              </span>
              <span className="file-action" id="pdf-picker-label">{file ? "Replace PDF" : "Choose PDF"}</span>
            </label>
            <div className="ocr-mode" data-mode={ocr?.live === "ready" ? "live" : "limited"}>
              <span className="signal" aria-hidden="true" />
              <div>
                <strong>{availability?.title ?? (historyLoaded ? "OCR status unknown" : "Checking OCR availability…")}</strong>
                {availability && <p>{availability.detail}</p>}
              </div>
            </div>
            {ocr?.live === "ready" && <label className="consent">
              <input name="allowCloud" type="checkbox" value="true" disabled={working} />
              <span>This PDF is synthetic or de-identified and approved for processing by external OCR services.</span>
            </label>}
            <div className="form-actions">
              <button className="button primary" type="submit" disabled={working}>
                {working ? "Saving PDF…" : ocr && !ocr.cache && ocr.live !== "ready" ? "Save policy PDF" : "Analyze policy"}
              </button>
              {file && !working && <button className="button secondary" type="button" onClick={() => {
                if (picker.current) picker.current.value = "";
                setFile(null);
                setError("");
                picker.current?.focus();
              }}>Clear file</button>}
            </div>
          </form>
        </section>}
    </div>
  </div>;
}
