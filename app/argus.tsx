"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import monogram from "./argus-monogram.svg";
import type { DragEvent, FormEvent } from "react";
import type { OcrMode } from "../lib/ocr-status";
import { ocrDescription } from "./ocr";
import { ReadingStage } from "./reading-eye";
import { useCachePreflight } from "./cache-preflight";
import { paintResult, useAnalysisMotion } from "./analysis-motion";
import { estimateCopy, type CacheCheck, type RunProgress } from "../lib/progress";
import { RunResult } from "./report";
import { SavedRun } from "./saved-runs";
import { Profile, ProfileAvatar } from "./profile";
import { api, json, message, RequestError } from "./client-api";
import { runHash as RUN_LINK, workspaceReturn, type ProfileSection, type Session } from "../lib/profile-settings";
import { AuthEntry } from "./auth-entry";
import { RunSettings } from "./run-settings";
import "./desk.css";
import type { ReviewSubmission, Run } from "./report";


type Signup = Session | { confirmationRequired: true };

type Surface = "intake" | "short" | "full" | "details";
type Submission = { started: number; id?: string; cancelled?: boolean; timer?: ReturnType<typeof setTimeout> };

function pending(run: Run) {
  return run.status === "processing" && Date.parse(run.lease_until ?? "") > Date.now();
}

function isCurrent(previous: Run, next: Run) {
  if (previous.id !== next.id) return false;
  if (previous.revision !== next.revision) return previous.revision > next.revision;
  const before = previous.progress?.updatedAt ?? "";
  const after = next.progress?.updatedAt ?? "";
  return before > after || (before === after && previous.status === next.status &&
    previous.pdf_cleanup_pending === next.pdf_cleanup_pending && previous.pdf_deleted_at === next.pdf_deleted_at &&
    (Boolean(previous.result) || !next.result));
}

function progressFor(run: Run | null, started: number, preflight?: CacheCheck): RunProgress {
  const now = new Date(started || Date.now()).toISOString();
  const progress = run?.progress ?? {
    stage: "uploading", status: run?.status === "queued" ? "queued" : "processing",
    pagesDone: 0, pagesTotal: preflight?.pagesTotal ?? null, startedAt: run?.created_at ?? now,
    stageStartedAt: now, updatedAt: now,
  };
  if (run && ["failed", "cancelled", "processing"].includes(run.status) && !pending(run)) {
    return { ...progress, stage: run.status === "cancelled" ? "cancelled" : "failed",
      status: run.status === "cancelled" ? "cancelled" : "failed" };
  }
  return progress as RunProgress;
}

type View = "signin" | "workspace" | "profile";

function showPath(path: string) {
  const hash = RUN_LINK.test(window.location.hash) ? window.location.hash : "";
  if (window.location.pathname !== path || window.location.search) {
    window.history.replaceState(null, "", path + hash);
  }
}

export default function Argus({ initialView, section }: { initialView: View; section?: ProfileSection }) {
  const [returnTo, setReturnTo] = useState("/workspace");
  const originalProfile = useRef("");
  const [profileDirty, setProfileDirty] = useState(false);
  const [view, setView] = useState(initialView);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [signedOutNotice, setSignedOutNotice] = useState("");
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
    if (initialView === "profile") {
      originalProfile.current = url.pathname + url.search;
      setReturnTo(workspaceReturn(url.searchParams.get("next")));
    } else setReturnTo(RUN_LINK.test(url.hash) ? `/workspace${url.hash}` : "/workspace?new=1");
    if (url.searchParams.get("view") === "signin" || url.searchParams.get("auth") === "confirmation_failed") start = "signin";
    if (url.searchParams.get("auth") === "confirmation_failed") {
      setError("The confirmation link could not be used. If you already confirmed your email, sign in.");
      showPath("/sign-in");
    }
    setView(start);
    api<Session | null>("/api/session", { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || credentialsSubmitted.current) return;
      setSession(result);
      if (!result) {
        setView("signin");
        showPath("/sign-in");
      } else if (result && start !== "profile") {
        setView("workspace");
        if (url.pathname !== "/workspace") showPath("/workspace");
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || credentialsSubmitted.current) return;
      if (!(error instanceof RequestError && error.status === 401)) setError(message(error));
      setSession(null);
      setView("signin");
      showPath("/sign-in");
    });
    return () => controller.abort();
  }, [initialView]);

  useEffect(() => {
    if (!moveAuthFocus.current) return;
    moveAuthFocus.current = false;
    if ((view === "workspace" || view === "profile") && session) main.current?.focus();
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
    setSignedOutNotice("");
    try {
      const result = await api<Signup>(creatingAccount ? "/api/signup" : "/api/session",
        json("POST", { email: address, password: data.get("password") }));
      moveAuthFocus.current = true;
      if ("confirmationRequired" in result) {
        setEmail(address);
        setConfirmationEmail(address);
      } else {
        setHandoff(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        if (originalProfile.current) {
          window.history.replaceState(null, "", originalProfile.current);
          setView("profile");
        } else {
          showPath("/workspace");
          setView("workspace");
        }
        setSession(result);
        setAuthMode("signin");
        setEmail("");
      }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (profileDirty && !window.confirm("Discard unsaved changes and sign out?")) return;
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

  function expireSession(reason = "Your session expired. Sign in to reopen your runs.", notice = "") {
    moveAuthFocus.current = true;
    setHandoff(false);
    setSession(null);
    setView("signin");
    showPath("/sign-in");
    setError(reason);
    setSignedOutNotice(notice);
    if (notice) originalProfile.current = "";
  }

  const isProfile = view === "profile";
  const isWorkspace = view === "workspace" || isProfile;
  const shellView = isWorkspace ? "workspace" : view;
  const profileURL = `/profile?next=${encodeURIComponent(returnTo)}`;
  return <div className="app-frame" data-view={shellView} data-appearance={session?.preferences?.appearance}
    data-density={session?.preferences?.density}>
    <a className="skip-link" href={isWorkspace && session ? "#work" : "#main"} onClick={event => {
      if (isWorkspace && session) {
        event.preventDefault();
        document.getElementById("work")?.focus();
      }
    }}>Skip to main content</a>
    <header className="masthead" data-view={shellView}>
      <a href={isWorkspace ? "/workspace" : "/"} className="brand" aria-label={isWorkspace ? "Argus workspace" : "Argus home"}>
        <Image src={monogram} alt="" width={40} height={40} unoptimized />
        Argus
      </a>
      {isWorkspace ? <>
        <span className="product">Review workspace</span>
        {session && <div className="account">
          <a className="profile-pill" href={profileURL} aria-label="Open profile" aria-current={isProfile ? "location" : undefined}
            title={session.email}>
            <ProfileAvatar session={session} />
            <span className="profile-email">{session.email}</span>
          </a>
          {!isProfile && <button type="button" className="button secondary open-history" aria-haspopup="dialog"
            aria-controls="history" aria-expanded={historyOpen} onClick={() => setHistoryOpen(true)}>Saved runs</button>}
          <button type="button" className="button secondary" onClick={signOut} disabled={busy}>Sign out</button>
        </div>}
      </> : null}
    </header>
    {handoff && <div className="auth-handoff" aria-hidden="true" onAnimationEnd={event => {
      if (event.target === event.currentTarget) setHandoff(false);
    }}>
      <Image src={`${monogram.src}?signin`} alt="" width={96} height={96} unoptimized loading="eager" />
    </div>}
    <main ref={main} id="main" className="shell" tabIndex={-1}>
      {isWorkspace ?
        session ? isProfile ? <Profile key={section} section={section ?? "account"} returnTo={returnTo}
          session={session} onSession={setSession} onUnauthorized={expireSession} sessionError={error} onDirty={setProfileDirty}
          onDeleted={() => expireSession("", "Your Argus account and its data were deleted.")} /> :
          <Workspace key={session.email} onUnauthorized={expireSession} sessionError={error}
            session={session} onLocation={setReturnTo} historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} /> :
          <p className="loading session-loading" role="status">Opening your workspace…</p> :
        <AuthEntry creatingAccount={creatingAccount} confirmationEmail={confirmationEmail} email={email}
          busy={busy} error={error} notice={signedOutNotice} headingRef={gateHeading} onEmail={setEmail} onSubmit={authenticate} onSwitch={switchAuthMode} />}
    </main>
  </div>;
}

function Workspace({ onUnauthorized, sessionError, historyOpen, setHistoryOpen, session, onLocation }: {
  onUnauthorized: () => void; sessionError: string; historyOpen: boolean; setHistoryOpen: (open: boolean) => void;
  session: Session; onLocation: (path: string) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [ocr, setOcr] = useState<OcrMode>();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const [compact, setCompact] = useState(false);
  const [consent, setConsent] = useState(false);
  const [fileError, setFileError] = useState("");
  const [restart, setRestart] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<string>(session.preferences?.decision_filter || "all");
  const [managed, setManaged] = useState<Run>();
  const removedRuns = useRef(new Set<string>());
  const [active, setActive] = useState<{ id: string } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [working, setWorking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [surface, setSurface] = useState<Surface>("intake");
  const surfaceRef = useRef<Surface>("intake");
  const stageSince = useRef(0);
  const submission = useRef<Submission | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const lastProgress = useRef<RunProgress | null>(null);
  const [beating, setBeating] = useState(false);
  const [choreography, setChoreography] = useState(false);
  const [arrived, setArrived] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [toast, setToast] = useState(false);
  const returnNotice = useRef<string | null>(null);
  const [failedReason, setFailedReason] = useState("");
  const { swap, interrupt } = useAnalysisMotion();
  const [error, setError] = useState("");
  const selected = useRef("");
  const focusRequested = useRef("");
  const pendingUpload = useRef<{ file: File; allowCloud: boolean; key: string } | null>(null);
  const live = useRef(false);
  const onAuthError = useRef(onUnauthorized);
  const [forceConsent, setForceConsent] = useState(false);
  const checked = useCachePreflight(file, onAuthError);
  const preflight: CacheCheck | undefined = forceConsent ? { cache: "miss", pagesTotal: null, pagesCached: 0 } : checked;
  const stageVisible = surface === "short" || surface === "full";
  const showIntake = surface === "intake";
  const uploading = submitting || working;

  function show(next: Surface) {
    if (next === "short" || next === "full") {
      if (surfaceRef.current !== "short" && surfaceRef.current !== "full") stageSince.current = Date.now();
    } else stageSince.current = 0;
    surfaceRef.current = next;
    setSurface(next);
  }

  function clearSubmission() {
    clearTimeout(submission.current?.timer);
    submission.current = null;
    setSubmitting(false);
  }

  useEffect(() => {
    const media = window.matchMedia("(width < 900px)");
    const update = () => {
      if (!media.matches) setHistoryOpen(false);
      setCompact(media.matches);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [setHistoryOpen]);

  useEffect(() => {
    if (compact && historyOpen && !drawer.current?.open) drawer.current?.showModal();
  }, [compact, historyOpen]);

  function closeHistory() {
    drawer.current?.close();
    setHistoryOpen(false);
  }

  useEffect(() => { onAuthError.current = onUnauthorized; }, [onUnauthorized]);

  function fail(error: unknown) {
    if (!live.current) return;
    if (error instanceof RequestError && error.status === 401) onAuthError.current();
    else setError(message(error));
  }

  function record(next: Run) {
    if (!live.current || removedRuns.current.has(next.id)) return;
    if (selected.current === next.id) {
      if (next.progress && next.status !== "complete" &&
          (lastProgress.current?.updatedAt ?? "") <= next.progress.updatedAt) lastProgress.current = next.progress;
      setRun(previous => previous && isCurrent(previous, next) ? previous : next);
    }
    setRuns(previous => {
      const existing = previous.find(saved => saved.id === next.id);
      if (existing && isCurrent(existing, next)) return previous;
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
      show("details");
    }
    api<{ runs: Run[]; ocr: OcrMode; nextCursor: string | null }>("/api/runs", { signal: controller.signal }).then(({ runs, ocr, nextCursor }) => {
      if (controller.signal.aborted) return;
      if (!id && !selected.current && session.preferences?.landing === "last" &&
          new URLSearchParams(window.location.search).get("new") !== "1") {
        const last = [...runs].filter(saved => !saved.deleting_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        if (last) select(last.id);
      }
      setRuns((current) => {
        const byId = new Map(runs.filter(saved => !removedRuns.current.has(saved.id)).map(saved => [saved.id, saved]));
        for (const saved of current) if ((byId.get(saved.id)?.revision ?? -1) <= saved.revision) byId.set(saved.id, saved);
        return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
      setOcr(ocr);
      setNextCursor(nextCursor);
      setHistoryLoaded(true);
    }).catch((error: unknown) => { if (!controller.signal.aborted) { fail(error); setHistoryLoaded(true); } });
    return () => { live.current = false; controller.abort(); };
  }, [restart]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await api<{ runs: Run[]; nextCursor: string | null }>(`/api/runs?after=${encodeURIComponent(nextCursor)}`);
      if (!live.current) return;
      setRuns(current => {
        const seen = new Set(current.map(item => item.id));
        return [...current, ...page.runs.filter(item => !seen.has(item.id) && !removedRuns.current.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      fail(error);
    } finally {
      if (live.current) setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const { id } = active;
    if (run?.id === id && !pending(run) && !run.pdf_cleanup_pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: number | undefined;
    const controller = new AbortController();
    async function refresh() {
      try {
        const { run } = await api<{ run: Run }>(`/api/runs/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        record(run);
        if (run.pdf_cleanup_pending) cleanupDeadline ??= Date.now() + 5000;
        if (pending(run) || (run.pdf_cleanup_pending && Date.now() < (cleanupDeadline ?? 0))) timer = setTimeout(refresh, 1000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RequestError && [401, 404, 410].includes(error.status)) {
          if (error.status !== 401) { setFailedReason(error.message); show("full"); }
          fail(error);
        } else if (!cleanupDeadline || Date.now() < cleanupDeadline) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, run?.pdf_cleanup_pending]);

  const backgroundIds = runs.filter(saved => saved.id !== active?.id && pending(saved)).map(saved => saved.id).join(",");
  useEffect(() => {
    if (!backgroundIds) return;
    const controller = new AbortController();
    const refresh = async () => {
      await Promise.all(backgroundIds.split(",").map(async id => {
        try {
          const { run: next } = await api<{ run: Run }>(`/api/runs/${id}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          record(next);
          if (next.status === "complete" && document.hidden) notifyHiddenCompletion(next.id);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof RequestError && error.status === 404) setRuns(previous => previous.filter(saved => saved.id !== id));
          else if (error instanceof RequestError && error.status === 401) onAuthError.current();
        }
      }));
      if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
    };
    let timer = setTimeout(refresh, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [backgroundIds]);

  function notifyHiddenCompletion(id: string) {
    document.title = "Argus · Done";
    returnNotice.current = id;
  }

  useEffect(() => {
    const original = document.title;
    function onReturn() {
      if (!document.hidden && returnNotice.current) {
        if (returnNotice.current === selected.current && surfaceRef.current === "details") {
          document.getElementById("result-title")?.focus({ preventScroll: true });
        }
        returnNotice.current = null;
        setToast(true);
        setAnnouncement("Analysis complete");
      }
    }
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      document.title = original;
    };
  }, []);

  useEffect(() => {
    if (!run || selected.current !== run.id) return;
    if (pending(run)) {
      const p = run.progress;
      document.title = p?.stage === "reading" && p.pagesTotal
        ? `Argus · Reading ${p.page ?? p.pagesDone}/${p.pagesTotal}` : "Argus · Analyzing";
      if (surfaceRef.current === "details" || (surfaceRef.current === "intake" && run.analysis_mode !== "instant")) {
        show(run.analysis_mode === "instant" ? "short" : "full");
      }
    } else if (stageSince.current && run.status !== "complete") document.title = "Argus · Run details";
    if (surfaceRef.current === "details" && !pending(run) && focusRequested.current === run.id) {
      focusRequested.current = "";
      document.getElementById("result-title")?.focus({ preventScroll: true });
    }
  }, [run, surface]);

  const ready = run?.status === "complete" && Boolean(run.result);
  const arriving = ready && surface !== "details";
  useEffect(() => {
    if (!run || !arriving) return;
    const id = run.id;
    let abandoned = false;
    const valid = () => !abandoned && live.current && selected.current === id;
    if (document.hidden) notifyHiddenCompletion(id);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (time: number) => time > 0 ? new Promise(resolve => setTimeout(resolve, time)) : Promise.resolve();
    void (async () => {
      await paintResult();
      const from = surfaceRef.current;
      if (from === "short" || from === "full") {
        const minimum = from === "short" ? 600 : 700;
        await wait(minimum - (Date.now() - stageSince.current));
        if (!valid()) return;
        setBeating(true);
        if (!reduced && !document.hidden) await wait(220);
      }
      if (!valid()) return;
      const finished = await swap(from === "intake" ? "instant" : "complete", () => show("details"), valid);
      if (!finished || !valid()) return;
      setBeating(false);
      setChoreography(!reduced && Boolean(document.startViewTransition));
      setFile(null);
      setConsent(false);
      focusRequested.current = "";
      if (!document.hidden) document.getElementById("result-title")?.focus({ preventScroll: true });
      document.title = "Argus · Done";
      setAnnouncement("Analysis complete");
      clearSubmission();
    })();
    return () => { abandoned = true; };
  }, [run?.id, ready, swap]);

  function select(id: string, fromUpload = false) {
    closeHistory();
    if (!fromUpload) {
      document.title = "Argus · Workspace";
      interrupt();
      clearSubmission();
      lastProgress.current = null;
      setAttempt(n => n + 1);
      setBeating(false);
      setChoreography(false);
      setFailedReason("");
      setAnnouncement("");
      const saved = runs.find(item => item.id === id);
      show(saved && pending(saved) ? saved.analysis_mode === "instant" ? "short" : "full" : "details");
    }
    if (selected.current !== id) setRun(null);
    selected.current = id;
    focusRequested.current = fromUpload ? "" : id;
    setActive({ id });
    window.history.replaceState(null, "", `/workspace#${id}`);
    onLocation(`/workspace#${id}`);
  }

  async function process(id: string, retryRevision?: number) {
    const { run: next } = await api<{ run: Run }>(`/api/runs/${id}`, retryRevision === undefined
      ? { method: "POST" } : json("POST", { retryOcr: true, revision: retryRevision }));
    if (selected.current === id && (retryRevision === undefined || pending(next))) {
      setFailedReason("");
      lastProgress.current = null;
      setAttempt(n => n + 1);
      setAnnouncement("");
      setBeating(false);
      setChoreography(false);
      stageSince.current = Date.now();
      show(next.analysis_mode === "instant" ? "short" : "full");
      setActive({ id });
    }
    record(next);
  }

  async function cancel(id?: string) {
    if (!id) {
      if (submission.current) submission.current.cancelled = true;
      setFailedReason("Cancelling after the upload finishes…");
      setAnnouncement("Cancellation requested. The PDF is still uploading.");
      return;
    }
    await action(async () => {
      const { run: next } = await api<{ run: Run }>(`/api/runs/${id}/cancel`, { method: "POST" });
      record(next);
      setFailedReason("");
    });
  }

  async function retryAnalysis() {
    if (!active) { newAnalysis(); return; }
    const { id } = active;
    await action(async () => {
      if (run && pending(run)) {
        try { await api(`/api/runs/${id}/cancel`, { method: "POST" }); }
        catch (error) { if (!(error instanceof RequestError && error.status === 409)) throw error; }
      }
      await process(id);
    });
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
    setForceConsent(false);
    if ((!next.name.toLowerCase().endsWith(".pdf") && next.type !== "application/pdf") ||
      !next.size || next.size > 20 * 1024 * 1024) {
      if (picker.current) picker.current.value = "";
      setFile(null);
      setConsent(false);
      setFileError("Choose a nonempty PDF up to 20 MiB.");
      return;
    }
    setFile(next);
    setConsent(false);
    setFileError("");
    setError("");
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    if (event.dataTransfer.files.length !== 1) {
      setFileError("Drop one PDF at a time.");
      return;
    }
    if (picker.current) picker.current.value = "";
    chooseFile(event.dataTransfer.files[0]);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file || !preflight || (preflight.cache !== "hit" && !consent) || fileError || uploading) return;
    const data = new FormData(form);
    data.set("pdf", file);
    const allowCloud = preflight.cache !== "hit" && consent;
    if (allowCloud) data.set("allowCloud", "true");
    else data.delete("allowCloud");
    if (pendingUpload.current?.file !== file || pendingUpload.current.allowCloud !== allowCloud) {
      pendingUpload.current = { file, allowCloud, key: crypto.randomUUID() };
    }
    const key = pendingUpload.current.key;
    lastProgress.current = null;
    setAttempt(n => n + 1);
    const request: Submission = { started: Date.now() };
    submission.current = request;
    setSubmitting(true);
    setAnnouncement("");
    setFailedReason("");
    setError("");
    const current = () => live.current && submission.current === request;
    if (preflight.cache === "hit") {
      request.timer = setTimeout(() => {
        if (!current()) return;
        show("short");
        request.timer = setTimeout(() => { if (current()) show("full"); }, 7600);
      }, 400);
    } else {
      void swap("live", () => show("full"), current);
    }
    try {
      const uploaded = await api<{ runId: string; mode: "instant" | "live"; cache: CacheCheck["cache"]; pagesToOcr: number; run: Run }>("/api/runs", {
        method: "POST", body: data, headers: { "Idempotency-Key": key },
      });
      request.id = uploaded.runId;
      let next = uploaded.run;
      if (request.cancelled && pending(next)) {
        try {
          const result = await api<{ run: Run }>(`/api/runs/${request.id}/cancel`, { method: "POST" });
          next = result.run;
        } catch (error) {
          if (!(error instanceof RequestError && error.status === 409)) throw error;
          next = (await api<{ run: Run }>(`/api/runs/${request.id}`)).run;
        }
      }
      if (!live.current) return;
      if (!current()) { record(next); return; }
      clearTimeout(request.timer);
      if (uploaded.pagesToOcr > 0 || uploaded.mode === "live") {
        if (surfaceRef.current !== "full") { interrupt(); show("full"); }
      } else if (pending(next)) {
        if (surfaceRef.current === "intake") show("short");
        request.timer = setTimeout(() => {
          if (current() && surfaceRef.current === "short") show("full");
        }, Math.max(0, 8000 - (Date.now() - request.started)));
      }
      if (next.status === "failed" || next.status === "cancelled") show("full");
      select(next.id, true);
      if (uploaded.mode === "instant" && next.status === "complete") setArrived(next.id);
      record(next);
      pendingUpload.current = null;
      if (uploaded.mode === "live") { setFile(null); setConsent(false); }
      setSubmitting(false);
    } catch (error) {
      if (!current()) return;
      interrupt();
      clearSubmission();
      show("intake");
      if (error instanceof RequestError && [400, 413, 415, 422].includes(error.status)) {
        if (error.status === 422 && preflight.cache === "hit" && /consent/i.test(error.message)) {
          // A saved extraction can be removed between preflight and submit.
          setForceConsent(true);
          setConsent(false);
        }
        setFileError(error.message);
      } else fail(error);
    }
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
    closeHistory();
    interrupt();
    clearSubmission();
    setBeating(false);
    setChoreography(false);
    setFailedReason("");
    setAnnouncement("");
    show("intake");
    focusRequested.current = "";
    document.title = "Argus · Workspace";
    setActive(null);
    setRun(null);
    setError("");
    const path = session.preferences?.landing === "last" ? "/workspace?new=1" : "/workspace";
    window.history.replaceState(null, "", path);
    onLocation("/workspace?new=1");
    setTimeout(() => document.getElementById("workspace-title")?.focus({ preventScroll: true }), 0);
  }

  // Keep the already mounted report subtree unchanged during the synchronous view swap.
  const preparedResult = useMemo(() => run && <RunResult key={run.id} run={run}
    preferences={session.preferences} working={working}
    onProcess={() => action(() => process(run.id, run.can_retry_ocr ? run.revision : undefined))}
    onConfirm={value => confirm(run.id, value)} />, [run, session.preferences, working]);

  const preparing = !run && Boolean(failedReason && !submitting);
  const progress = ready && !beating && lastProgress.current ? lastProgress.current :
    progressFor(run, submission.current?.started ?? stageSince.current, preflight);
  const availability = ocr && ocrDescription(ocr);
  const query = historyQuery.trim().toLowerCase();
  const visibleRuns = runs.filter(item => {
    const status = item.decision ?? item.result?.status ?? item.status;
    return (item.filename.toLowerCase().includes(query) || item.display_name?.toLowerCase().includes(query)) &&
      (decisionFilter === "all" || status === decisionFilter);
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.created_at.localeCompare(a.created_at));
  const history = <>
    <div className="history-top">
      <div className="history-heading">
        <h2 id="history-title">Saved runs</h2>
        {compact && <button className="button secondary" type="button" onClick={closeHistory}>Close</button>}
      </div>
      <button className="button secondary new-analysis" type="button" aria-current={showIntake ? "page" : undefined}
        onClick={newAnalysis}>New analysis</button>
    </div>
    {runs.length > 0 && <div className="history-controls">
      <input type="search" aria-label="Search saved runs" value={historyQuery} placeholder="Search runs"
        onChange={event => setHistoryQuery(event.target.value)} />
      <div className="decision-control">
        <select aria-label="Decision" value={decisionFilter} onChange={event => setDecisionFilter(event.target.value)}>
          <option value="all">All decisions</option>
          <option value="ambiguous">Needs review</option>
          <option value="resolved">Resolved</option>
          <option value="unsupported">Unsupported</option>
        </select>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>}
    {visibleRuns.length > 0 ? <ul className="history-list" aria-label="Saved policy runs">{visibleRuns.map(item =>
      <SavedRun key={item.id} run={item} personal={session.personal} preferences={session.preferences} current={active?.id === item.id} arrived={arrived === item.id}
        onOpen={() => {
          setError("");
          select(item.id);
        }} onManage={() => setManaged(item)} />)}</ul> :
      <p className="history-empty" role="status">{runs.length ? nextCursor ? "No matches in the loaded runs." : "No runs match this filter." :
        historyLoaded ? (ocr ? "Your first analysis will appear here." : "Saved runs are unavailable.") : "Loading saved runs…"}</p>}
    {nextCursor && <button className="button secondary" type="button" onClick={loadMore} disabled={loadingMore}>
      {loadingMore ? "Loading saved runs…" : "Load more saved runs"}
    </button>}
  </>;
  const hit = preflight?.cache === "hit";
  const remaining = preflight?.pagesTotal != null ? preflight.pagesTotal - preflight.pagesCached : null;
  const expectation = !preflight ? "" : hit ? "Analyzed before. Result is instant, no external OCR needed." :
    `${preflight.cache === "partial" ? "Some pages are already analyzed." : "New PDF."} ${remaining != null
      ? `Live OCR for ${remaining} of ${preflight.pagesTotal} pages, ${preflight.estimatedSeconds
        ? `usually ${estimateCopy(preflight.estimatedSeconds)}` : "this can take a few minutes"}.`
      : "Live OCR can take a few minutes."}`;
  const submitHint = !file ? "Choose a PDF to continue." : !preflight ? "Checking for saved analysis…" :
    !hit && !consent ? "Check the box to allow live OCR." : "";

  return <div className="workspace">
    {compact ? <dialog ref={drawer} className="history history-drawer" id="history" aria-labelledby="history-title"
      onClose={() => setHistoryOpen(false)}>{history}</dialog> :
      <aside className="history history-desktop" id="history" aria-labelledby="history-title" tabIndex={-1}>{history}</aside>}
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
      <div className="analysis-region" data-choreography={choreography}>
        {run && (surface === "details" || arriving) && <div className="analysis-preload" data-preload={arriving} inert={arriving}>
          {preparedResult}
        </div>}
        {surface === "details" && !run && <p className="loading" role="status">Opening saved run…</p>}
        {(showIntake || stageVisible) && <section className="intake analysis-entry" aria-labelledby="workspace-title">
          <header className="intake-heading"><p className="page-eyebrow">Policy check</p>
            <h1 id="workspace-title" tabIndex={-1}>New analysis</h1>
            <div className="title-rule" aria-hidden="true" />
            <p>Check own damage and third-party commission against the insurer’s rate card.</p>
          </header>
          {stageVisible ? <div className="analysis-card">
            <ReadingStage key={attempt}
              progress={preparing ? { ...progress, stage: "failed", status: "failed" } : progress} short={surface === "short"}
              beating={beating} reason={failedReason || run?.error || (run?.status === "processing" && !pending(run)
                ? "The analysis was interrupted. Retry from your saved original." : null)}
              disabled={working || (submitting && Boolean(failedReason))}
              onCancel={() => void cancel(active?.id ?? submission.current?.id)} onRetry={() => void retryAnalysis()}
              onDetails={() => {
                if (run) { focusRequested.current = run.id; show("details"); }
                else newAnalysis();
              }} />
          </div> :
          <form className="upload intake-form analysis-card" onSubmit={upload} aria-busy={uploading}>
            <fieldset disabled={uploading}>
              <div className="file-control" data-dragging={dragging} data-selected={Boolean(file)} data-error={Boolean(fileError)}
                onDragOver={event => {
                  if (!event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = uploading ? "none" : "copy";
                  if (!uploading) setDragging(true);
                }}
                onDragLeave={event => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
                }} onDrop={dropFile}>
                <input ref={picker} id="policy-pdf" name="pdf" type="file" accept=".pdf,application/pdf" hidden
                  aria-label="Choose PDF" onChange={event => chooseFile(event.target.files?.[0] ?? null)} />
                  <button ref={choose} type="button" className="file-picker" onClick={() => picker.current?.click()}
                    aria-label={file ? "Replace PDF" : "Choose PDF"}
                    aria-describedby={fileError ? "pdf-selection pdf-limit pdf-error" : "pdf-selection pdf-limit"}>
                    <svg className="file-mark intake-eye-transfer" viewBox="0 0 32 36" width="48" height="48" aria-hidden="true">
                      <path d="M6 2h13l7 7v23a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm13 0v7h7" />
                      {file ? <path d="m10 21 4 4 7-8" /> : <path d="M10 17h10m-10 6h7" />}
                    </svg>
                    <span className="file-copy" aria-live="polite" aria-atomic="true">
                      <strong className="file-title" id="pdf-selection">{file?.name ?? "Drop a motor policy PDF here"}</strong>
                      <span className="file-limit" id="pdf-limit">{file ? `${Math.max(1, Math.ceil(file.size / 1024)).toLocaleString()} KiB` : "PDF up to 20 MiB"}</span>
                    </span>
                    <span className="button secondary">{file ? "Replace PDF" : "Choose PDF"}</span>
                  </button>
                  {file && <button className="button secondary remove-file" type="button" onClick={() => {
                    if (picker.current) picker.current.value = "";
                    setFile(null);
                    setForceConsent(false);
                    setConsent(false);
                    setFileError("");
                    setError("");
                    choose.current?.focus();
                  }}>Remove</button>}
                  {fileError && <p id="pdf-error" className="file-error" role="alert">{fileError}</p>}
              </div>
              <div className="cache-chip-row" aria-live="polite" aria-atomic="true">
                {expectation && <span className="cache-chip" key={expectation} data-hit={hit}>{expectation}</span>}
              </div>
              <p className="intake-value">You get the commission rate, the exact grid cell it came from, or a clear 'cannot determine'.</p>
              <div className="upload-consent">
                <div className="ocr-mode" data-mode={ocr?.live === "ready" ? "live" : "limited"}>
                  <span className="signal" aria-hidden="true" />
                  <div>
                    <strong>{availability?.title ?? (historyLoaded ? "OCR status unknown" : "Checking OCR availability…")}</strong>
                    {availability && <p>{availability.detail}</p>}
                  </div>
                </div>
                <div className="consent-slot">
                  {ocr && !hit && <label className="consent">
                    <input name="allowCloud" type="checkbox" value="true" checked={consent}
                      onChange={event => { setConsent(event.target.checked); if (fileError.includes("consent")) setFileError(""); }} />
                    <span>This PDF is synthetic or de-identified and approved for processing by external OCR services.</span>
                  </label>}
                </div>
                <div className="form-actions">
                  <button className="button primary" type="submit" aria-describedby={submitHint && !uploading ? "submit-hint" : undefined}
                    disabled={uploading || !file || !preflight || (!hit && !consent) || Boolean(fileError)}>
                    {submitting ? "Opening analysis…" : "Analyze policy"}
                  </button>
                  {!uploading && submitHint && <p id="submit-hint">{submitHint}</p>}
                </div>
              </div>
            </fieldset>
          </form>}
        </section>}
      </div>
      <p className="sr-only" role="status" aria-atomic="true">{announcement}</p>
      {toast && <div className="analysis-toast"><span>Analysis complete</span>
        <button type="button" className="button secondary" onClick={() => setToast(false)}>Dismiss</button>
      </div>}
    </div>
  </div>;
}
