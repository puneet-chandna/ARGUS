"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, json, message, RequestError } from "./client-api";
import { auditActions, personalDefaults, preferenceDefaults, profileDate, profilePaths,
  type AuditEvent, type Personal, type Preferences, type ProfileSection, type Session } from "../lib/profile-settings";
import type { SessionRow } from "../lib/profile";
import { RunStatus } from "./report";
import { ExportButton } from "./profile-export-button";
import "./profile.css";

type Account = Required<Session> & { stats: number[] | null; memberSince: string; verified: boolean; timedRetention: boolean };
type Task = (action: () => Promise<void>, success: string) => Promise<void>;
type Confirmation = { title: string; detail: ReactNode; label: string; typed?: boolean; danger?: boolean; run: () => Promise<void>; success: string };

export function ProfileAvatar({ session, large = false, preview }: { session: Session; large?: boolean; preview?: string }) {
  const initial = Array.from((session.personal?.display_name || session.email || "A").trim())[0]?.toLocaleUpperCase() ?? "A";
  const revision = session.personal?.avatar_revision;
  const source = preview || (revision ? `/api/profile/avatar?v=${encodeURIComponent(revision)}` : "");
  const [failedSource, setFailedSource] = useState("");
  return <span className={large ? "avatar avatar-large" : "avatar"} aria-hidden="true">
    {source && source !== failedSource ? <img src={source} alt="" onError={() => setFailedSource(source)} /> : initial}
  </span>;
}

function useUnsaved(dirty: boolean, onDirty: (dirty: boolean) => void) {
  useEffect(() => {
    onDirty(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true; };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); onDirty(false); };
  }, [dirty, onDirty]);
}

function ConfirmDialog({ item, onClose, onSuccess, onError }: {
  item: Confirmation; onClose: () => void; onSuccess: (message: string) => void; onError: (error: unknown) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    cancel.current?.focus();
  }, []);
  return <dialog ref={ref} className="run-settings profile-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <h2 id={`${id}-title`}>{item.title}</h2>
    <div className="confirm-details" id={`${id}-description`}>{item.detail}</div>
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy || (item.typed && value !== "DELETE")) return;
      setBusy(true);
      setError("");
      try { await item.run(); onSuccess(item.success); ref.current?.close(); }
      catch (error) { onError(error); setError(message(error)); }
      finally { setBusy(false); }
    }} aria-busy={busy}>
      {item.typed && <label>Type DELETE to confirm
        <input autoComplete="off" value={value} onChange={event => setValue(event.target.value)} disabled={busy}
          aria-describedby={`${id}-hint`} />
      </label>}
      {item.typed && <p id={`${id}-hint`} className="profile-meta">This action can’t be undone.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="profile-actions">
        <button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={() => ref.current?.close()}>Cancel</button>
        <button className={`button ${item.danger ? "danger-button" : "primary"}`} disabled={busy || (item.typed && value !== "DELETE")}>
          {busy ? "Working…" : item.label}
        </button>
      </div>
    </form>
  </dialog>;
}

export function Profile({ section, returnTo, session, onSession, onUnauthorized, sessionError, onDirty, onDeleted }: {
  section: ProfileSection; returnTo: string; session: Session; onSession: (session: Session) => void;
  onUnauthorized: () => void; sessionError: string; onDirty: (dirty: boolean) => void; onDeleted: () => void;
}) {
  const [account, setAccount] = useState<Account>();
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [retry, setRetry] = useState(0);
  const authError = useRef(onUnauthorized);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia("(width < 900px)").matches) {
      navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [section]);
  useEffect(() => { authError.current = onUnauthorized; }, [onUnauthorized]);
  function handleError(error: unknown) {
    if (error instanceof RequestError && error.status === 401) authError.current();
  }
  useEffect(() => {
    if (section === "security" || section === "activity") return;
    const controller = new AbortController();
    api<Account>(`/api/profile?view=${section}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setAccount(data);
    }).catch(error => {
      if (controller.signal.aborted) return;
      handleError(error);
      setError(message(error));
    });
    return () => controller.abort();
  }, [section, retry]);
  const task: Task = async (run, success) => {
    setBusy(true);
    setError("");
    setToast("");
    try { await run(); setToast(success); }
    catch (error) { handleError(error); setError(message(error)); }
    finally { setBusy(false); }
  };
  function update(data: Required<Session>) {
    setAccount(current => current && { ...current, ...data });
    onSession(data);
  }
  const shared = { task, busy, onDirty };
  return <div className="workspace profile-layout">
    <aside className="history settings-sidebar">
      <a className="back-workspace" href={returnTo}>← Back to workspace</a>
      <p className="settings-label" id="settings-nav-title">Settings</p>
      <nav ref={navigation} aria-labelledby="settings-nav-title">
        {(Object.keys(profilePaths) as ProfileSection[]).map(name => <a key={name} aria-current={section === name ? "page" : undefined}
          href={`/profile${name === "account" ? "" : "/" + name}?next=${encodeURIComponent(returnTo)}`}>{profilePaths[name]}</a>)}
      </nav>
    </aside>
    <div className="work" id="work" tabIndex={-1}>
      <div className="profile-content">
        <header className="profile-heading">
          <p className="page-eyebrow">Profile</p>
          <h1>{profilePaths[section]}</h1>
          <div className="title-rule" aria-hidden="true" />
          <p>{{
            account: "Your details, preferences and data. Changes apply to this workspace only.",
            preferences: "Choose how the workspace looks and which runs you see first.",
            security: "Manage your sign-in details and devices.",
            activity: "Review what happened in your workspace and when.",
            data: "Choose what Argus keeps and export or delete your data.",
          }[section]}</p>
        </header>
        {(error || sessionError) && <div className="error" role="alert">{error || sessionError}
          {!account && !["security", "activity"].includes(section) && <button className="button secondary" type="button"
            onClick={() => { setError(""); setRetry(value => value + 1); }}>Retry</button>}
        </div>}
        <p className="profile-toast" role="status">{toast}</p>
        {section === "security" ? <Security session={session} confirm={setConfirmation} handleError={handleError} {...shared} /> :
          section === "activity" ? <Activity session={session} handleError={handleError} /> :
          account ? section === "account" ? <AccountForm account={account} update={update} confirm={setConfirmation} {...shared} /> :
            <PreferenceForm data={section === "data"} account={account} update={update} confirm={setConfirmation}
              handleError={handleError} onDeleted={onDeleted} {...shared} /> :
            !error && <p className="loading" role="status">Loading settings…</p>}
        {confirmation && <ConfirmDialog item={confirmation} onClose={() => setConfirmation(undefined)} onError={handleError} onSuccess={setToast} />}
      </div>
    </div>
  </div>;
}

type Editor = { task: Task; busy: boolean; onDirty: (dirty: boolean) => void };
type AccountEditor = Editor & { account: Account; update: (data: Required<Session>) => void; confirm: (item: Confirmation) => void };

function Save({ dirty, busy, invalid }: { dirty: boolean; busy: boolean; invalid?: boolean }) {
  return <div className="profile-actions">
    <button className="button primary" disabled={!dirty || busy || invalid}>{busy ? "Saving…" : "Save changes"}</button>
    <span className="profile-meta">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
  </div>;
}

function AccountForm({ account, update, task, busy, onDirty, confirm }: AccountEditor) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const { display_name, organization, clock, time_zone } = account.personal ?? personalDefaults;
  const base = { display_name, organization, clock, time_zone: time_zone ?? browserZone };
  const [fields, setFields] = useState<Personal>(base);
  const [preview, setPreview] = useState<File>();
  const [previewURL, setPreviewURL] = useState("");
  const [photoError, setPhotoError] = useState("");
  const photoPicker = useRef<HTMLInputElement>(null);
  const dirty = Object.keys(base).some(name => base[name as keyof Personal] !== fields[name as keyof Personal]);
  useUnsaved(dirty || Boolean(preview), onDirty);
  useEffect(() => {
    if (!preview) { setPreviewURL(""); return; }
    const url = URL.createObjectURL(preview);
    setPreviewURL(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  const issue = (field: "display_name" | "organization", limit: number) =>
    fields[field].length > limit || /\p{Cc}/u.test(fields[field]) ? `Use up to ${limit} characters and no line breaks.` : "";
  let zoneError = "";
  try {
    if (!fields.time_zone || fields.time_zone.length > 100) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: fields.time_zone });
  } catch { zoneError = "Enter a valid time zone, for example Asia/Kolkata."; }
  const issues = { display_name: issue("display_name", 80), organization: issue("organization", 120), time_zone: zoneError };
  const invalid = Object.values(issues).some(Boolean);
  const zones = Intl.supportedValuesOf("timeZone");
  function textField(field: "display_name" | "organization" | "time_zone", label: string) {
    return <label>{label}<input value={fields[field] ?? ""} list={field === "time_zone" ? "profile-time-zones" : undefined}
      aria-invalid={Boolean(issues[field]) || undefined} aria-describedby={`${field}-issue`}
      onChange={event => setFields({ ...fields, [field]: event.target.value })} />
      <span id={`${field}-issue`} className="field-issue" aria-live="polite">{issues[field]}</span>
    </label>;
  }
  return <>
    <section className="profile-card profile-summary" aria-label="Profile card">
      <ProfileAvatar session={account} large preview={previewURL} />
      <div className="profile-identity">
        <h2>{display_name || "Reviewer"}</h2>
        <div className="profile-tags">
          <span>{account.email}</span>
          {account.verified && <span className="profile-tag verified">Verified</span>}
          <span className="profile-tag">Reviewer</span>
        </div>
        <p className="profile-meta">Member since <time dateTime={account.memberSince}>{profileDate(account.memberSince, account.personal, true)}</time></p>
      </div>
      <div className="profile-actions photo-actions">
        <input type="file" ref={photoPicker} hidden accept="image/png,image/jpeg"
          onChange={event => {
            const photo = event.target.files?.[0];
            event.target.value = "";
            if (!photo) return;
            if (!["image/png", "image/jpeg"].includes(photo.type) || photo.size > 2_000_000 || !photo.size) {
              setPhotoError("Choose a PNG or JPG up to 2 MB.");
              return;
            }
            setPhotoError("");
            setPreview(photo);
          }} />
        <button type="button" className="button secondary" disabled={busy}
          aria-describedby="avatar-error" onClick={() => photoPicker.current?.click()}>Upload photo</button>
        {preview ? <>
          <button type="button" className="button primary" disabled={busy} onClick={() => void task(async () => {
            const encoded = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(",")[1]);
              reader.onerror = reject;
              reader.readAsDataURL(preview);
            });
            const out = await api<{ avatar_revision: string }>("/api/profile/avatar", json("PUT", { image: encoded }));
            update({ ...account, personal: { ...account.personal, ...out } });
            setPreview(undefined);
          }, "Profile photo saved.")}>{busy ? "Uploading…" : "Save photo"}</button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => setPreview(undefined)}>Cancel preview</button>
        </> : account.personal.avatar_revision && <button type="button" className="button secondary danger-link" disabled={busy} onClick={() => confirm({
          title: "Remove your profile photo?", detail: <p>Your initials will replace the photo.</p>, label: "Remove photo",
          danger: true, success: "Profile photo removed.", run: async () => {
            await api("/api/profile/avatar", { method: "DELETE" });
            update({ ...account, personal: { ...account.personal, avatar_revision: null } });
          },
        })}>Remove</button>}
      </div>
      <p id="avatar-error" className="field-issue" aria-live="polite">{photoError}</p>
    </section>
    {account.stats && <section aria-labelledby="stats-title">
      <h2 className="settings-label" id="stats-title">Last 30 days</h2>
      <dl className="profile-stats">{["Analyses run", "Resolved", "Needs review", "Unsupported"].map((label, index) =>
        <div className="profile-card" key={label}>
          <dt><span className={`stat-dot stat-${index}`} aria-hidden="true" />{label}</dt><dd>{account.stats?.[index]}</dd>
        </div>)}</dl>
    </section>}
    <section className="profile-card settings-card" aria-labelledby="personal-title">
      <h2 id="personal-title">Personal details</h2>
      <p className="profile-meta">Set your workspace name and how dates and times appear.</p>
      <form aria-busy={busy} onSubmit={event => {
        event.preventDefault();
        if (!dirty || invalid || busy) return;
        void task(async () => {
          const result = await api<Required<Session>>("/api/profile", json("PATCH", { part: "personal", ...fields }));
          const { display_name, organization, clock, time_zone } = result.personal;
          setFields({ display_name, organization, clock, time_zone });
          update(result);
        }, "Personal details saved.");
      }}>
        <fieldset disabled={busy} className="profile-fields">
          {textField("display_name", "Display name")}
          <label>Email<input className="readonly" value={account.email} readOnly /></label>
          {textField("organization", "Organization")}
          <label>Role<input className="readonly" value="Reviewer" readOnly /></label>
          {textField("time_zone", "Time zone")}
          <datalist id="profile-time-zones">{[...new Set([browserZone, "UTC", ...zones])].map(zone => <option key={zone} value={zone} />)}</datalist>
          <fieldset className="clock-field">
            <legend>Time format</legend>
            <div className="segmented">{(["24", "12"] as const).map(value => <label key={value}>
              <input type="radio" name="clock" value={value} checked={fields.clock === value}
                onChange={() => setFields({ ...fields, clock: value })} />
              <span>{value} hour</span>
            </label>)}</div>
          </fieldset>
        </fieldset>
        <Save dirty={dirty} busy={busy} invalid={invalid} />
      </form>
    </section>
  </>;
}

function PreferenceForm({ data, account, update, confirm, task, busy, onDirty, handleError, onDeleted }: AccountEditor & {
  data: boolean; handleError: (error: unknown) => void; onDeleted: () => void;
}) {
  const [fields, setFields] = useState(account.preferences ?? preferenceDefaults);
  const dirty = Object.keys(fields).some(key => fields[key as keyof Preferences] !== account.preferences[key as keyof Preferences]);
  useUnsaved(dirty, onDirty);
  function select<K extends keyof Preferences>(key: K, title: string, choices: readonly (readonly [Preferences[K], string])[]) {
    return <label>{title}<select value={String(fields[key])} onChange={event => {
      const selected = choices.find(([value]) => String(value) === event.target.value);
      if (selected) setFields({ ...fields, [key]: selected[0] });
    }}>{choices.map(([value, label]) => <option key={String(value)} value={String(value)}>{label}</option>)}</select></label>;
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || busy) return;
    const run = async () => {
      const result = await api<Required<Session>>("/api/profile", json("PATCH", {
        ...fields, part: data ? "data" : "preferences",
        retention_days: data && !account.timedRetention ? undefined : fields.retention_days,
      }));
      setFields(result.preferences);
      update(result);
    };
    const destructive = (fields.retention_days ?? Infinity) < (account.preferences.retention_days ?? Infinity) ||
      (fields.delete_originals && !account.preferences.delete_originals);
    const success = "Preferences saved.";
    if (data && destructive) confirm({
      title: "Change automatic deletion?", detail: <p>Expired runs will be removed on the scheduled cleanup. If you enabled original PDF deletion, new analyses will lose access to the original file and manual PDF review.</p>,
      label: "Confirm settings", danger: true, success, run,
    });
    else void task(run, success);
  }
  const remove = (target: "runs" | "account") => confirm({
    title: target === "runs" ? "Delete all saved runs?" : "Delete your account?",
    detail: target === "runs" ? <p>All saved analyses, original PDFs and their reusable readings will be removed. Your account and audit log will remain.</p> :
      <><p>This permanently removes:</p><ul><li>Your sign-in, profile and preferences</li>
        <li>All saved runs, PDFs and reusable readings</li><li>Your activity and OCR approvals</li></ul></>,
    label: target === "runs" ? "Delete all saved runs" : "Permanently delete account",
    typed: true, danger: true, success: "Saved runs deleted.", run: async () => {
      await api("/api/profile", json("DELETE", { target, confirmation: "DELETE" }));
      if (target === "account") onDeleted();
    },
  });
  return <>
    <section className="profile-card settings-card" aria-labelledby="preferences-title">
      <h2 id="preferences-title">{data ? "Run retention" : "Workspace preferences"}</h2>
      {data && <p className="profile-meta">Argus keeps saved runs until you delete them unless you choose timed retention.</p>}
      <form onSubmit={submit} aria-busy={busy}>
        {data ? <>
          <fieldset disabled={busy} className="profile-fields data-fields">
            {account.timedRetention ? select("retention_days", "Keep saved runs", [[null, "Until deleted"], [30, "30 days"], [90, "90 days"], [365, "1 year"]])
              : <p className="profile-meta">Timed retention: Not available yet. Runs are kept until deleted{account.preferences.retention_days ? " or timed cleanup resumes" : ""}.</p>}
            <label className="consent"><input type="checkbox" checked={fields.delete_originals} aria-describedby="original-hint"
              onChange={event => setFields({ ...fields, delete_originals: event.target.checked })} />Delete original PDFs after analysis</label>
            <p id="original-hint" className="profile-meta">Applies to new completed analyses. The result remains, but you can’t reopen or manually review the original PDF.</p>
            <label className="consent"><input type="checkbox" checked disabled aria-describedby="ocr-lock" />Always ask before sending a PDF to external OCR</label>
            <p id="ocr-lock" className="profile-meta">Argus asks every time. This cannot be turned off.</p>
          </fieldset>
        </> : <fieldset disabled={busy} className="profile-fields">
          {select("appearance", "Appearance", [["light", "Light"], ["dark", "Dark"], ["system", "System"]])}
          {select("density", "Density", [["comfortable", "Comfortable"], ["compact", "Compact"]])}
          {select("landing", "Default workspace screen", [["new", "New analysis"], ["last", "Last run"]])}
          {select("decision_filter", "Default saved runs filter", [["all", "All decisions"], ["resolved", "Resolved"], ["ambiguous", "Needs review"], ["unsupported", "Unsupported"]])}
          {select("decimals", "Commission decimal places", [[1, "1 decimal place"], [2, "2 decimal places"]])}
          {select("percent_sign", "Commission percent sign", [[true, "Show"], [false, "Hide"]])}
        </fieldset>}
        <Save busy={busy} dirty={dirty} />
      </form>
    </section>
    {data && <>
      <section className="profile-card settings-card">
        <h2>Export my data</h2><p className="profile-meta">Download account details, saved analyses and audit history as JSON and CSV in a ZIP. Original PDFs aren’t included.</p>
        <ExportButton type="data" handleError={handleError} />
      </section>
      <section className="profile-card settings-card">
        <h2>Delete saved runs</h2><p className="profile-meta">Remove all saved analyses and their original PDFs.</p>
        <div className="profile-actions"><button className="button secondary danger-link" type="button" onClick={() => remove("runs")}>Delete all saved runs</button></div>
      </section>
      <section className="profile-card settings-card danger-zone">
        <h2>Danger zone</h2><p className="profile-meta">Permanently delete your Argus account and its data.</p>
        <div className="profile-actions"><button className="button danger-button" type="button" onClick={() => remove("account")}>Delete account</button></div>
      </section>
      <nav className="legal-links" aria-label="Legal"><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a></nav>
    </>}
  </>;
}

function describeDevice(ua: string | null) {
  if (!ua) return "Unknown device or browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" :
    /Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown device";
  return `${browser} · ${os}`;
}

function Security({ session, task, busy, confirm, handleError }: Editor & {
  session: Session; confirm: (item: Confirmation) => void; handleError: (error: unknown) => void;
}) {
  const [security, setSecurity] = useState<{ provider: string; password: boolean; sessions: SessionRow[] }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [match, setMatch] = useState("");
  const strength = Number(password.length >= 8) + Number(password.length >= 12) +
    Number(/[A-Z]/.test(password) && /[a-z]/.test(password)) + Number(/[0-9]/.test(password) && /\W/.test(password));
  const byteLength = new TextEncoder().encode(password).length;
  const passwordIssue = password && (password.length < 8 || byteLength > 72 || password === current) ? "Use a different password of at least 8 characters and at most 72 bytes." : "";
  const matchIssue = match && match !== password ? "Passwords don’t match." : "";
  useEffect(() => {
    const controller = new AbortController();
    api<NonNullable<typeof security>>("/api/profile?view=security", { signal: controller.signal }).then(setSecurity).catch(error => {
      if (controller.signal.aborted) return;
      handleError(error);
      setError(message(error));
    });
    return () => controller.abort();
  }, [retry]);
  function revoke(target: string, thisDevice = false) {
    const others = target === "others";
    confirm({
      title: others ? "Sign out of all other sessions?" : "Sign out of this session?",
      detail: <p>{thisDevice ? "You’ll return to sign-in." : "The selected device will need to sign in again when its access token expires."}</p>,
      label: others ? "Sign out of other sessions" : "Sign out", success: others ? "Other sessions signed out." : "Session signed out.",
      run: async () => {
        if (thisDevice) {
          await api("/api/session", { method: "DELETE" });
          window.location.assign("/sign-in");
        } else {
          await api("/api/profile", json("PATCH", { part: "revoke", target }));
          setRetry(value => value + 1);
        }
      },
    });
  }
  if (!security) return error ? <p className="error" role="alert">{error} <button className="button secondary" onClick={() => {
    setError(""); setRetry(value => value + 1);
  }}>Retry</button></p> : <p role="status">Loading security settings…</p>;
  return <>
    <section className="profile-card settings-card"><h2>Sign-in method</h2><p>{security.provider}</p></section>
    {security.password && <section className="profile-card settings-card">
      <h2>Change password</h2>
      <form aria-busy={busy} onSubmit={event => {
        event.preventDefault();
        if (busy || passwordIssue || match !== password || !current || !password) return;
        void task(async () => {
          await api("/api/profile", json("PATCH", { part: "password", current, password, confirm: match }));
          setCurrent(""); setPassword(""); setMatch(""); setRetry(value => value + 1);
        }, "Password changed.");
      }}>
        <fieldset className="profile-fields" disabled={busy}>
          <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} /></label>
          <label>New password<input type="password" autoComplete="new-password" value={password} aria-describedby="password-issue"
            aria-invalid={Boolean(passwordIssue) || undefined} onChange={event => setPassword(event.target.value)} />
            <span className="field-issue" id="password-issue" aria-live="polite">{passwordIssue}</span></label>
          <label>Confirm new password<input type="password" autoComplete="new-password" value={match} aria-describedby="match-issue"
            aria-invalid={Boolean(matchIssue) || undefined} onChange={event => setMatch(event.target.value)} />
            <span className="field-issue" id="match-issue" aria-live="polite">{matchIssue}</span></label>
          <div className="password-strength">
            <span id="password-strength-label">Password strength: {["None", "Weak", "Fair", "Good", "Strong"][strength]}</span>
            <meter min={0} max={4} value={strength} aria-labelledby="password-strength-label" />
          </div>
        </fieldset>
        <div className="profile-actions"><button className="button primary" disabled={busy || !current || !password || Boolean(passwordIssue) || match !== password}>
          {busy ? "Changing…" : "Change password"}</button></div>
      </form>
    </section>}
    <section className="profile-card settings-card"><h2>Two-factor authentication</h2><p className="profile-meta">Not available yet.</p></section>
    <section className="profile-card settings-card">
      <h2>Active sessions</h2><p className="profile-meta">Location isn’t collected by Argus. Last active reflects the last session refresh.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!security.sessions.length ? <p>No active sessions found.</p> : <div className="profile-table" role="table" aria-label="Active sessions">
        <div className="table-row table-head" role="row">{["Device and browser", "Last active", "Actions"].map(title =>
          <span key={title} role="columnheader">{title}</span>)}</div>
        {security.sessions.map(row => <div className="table-row" role="row" key={row.id}>
          <div role="cell">{describeDevice(row.user_agent)} {row.current_device && <span className="profile-tag">This device</span>}</div>
          <div role="cell"><span className="mobile-cell-label" aria-hidden="true">Last active</span>
            <time title={row.last_active} dateTime={row.last_active}>{profileDate(row.last_active, session.personal)}</time></div>
          <div role="cell"><button type="button" className="button secondary" onClick={() => revoke(row.id, row.current_device)}>Sign out</button></div>
        </div>)}
      </div>}
      {security.sessions.some(row => !row.current_device) && <div className="profile-actions">
        <button type="button" className="button secondary" onClick={() => revoke("others")}>Sign out of all other sessions</button>
      </div>}
    </section>
  </>;
}

type ActivityData = { activity: { events: AuditEvent[]; count: number }; approvals: { events: AuditEvent[]; count: number } };
type Filters = { action: string; start: string; end: string };
const emptyFilters = { action: "", start: "", end: "" };

function Activity({ session, handleError }: { session: Session; handleError: (error: unknown) => void }) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [activity, setActivity] = useState<ActivityData>();
  const [page, setPage] = useState(0);
  const [approvalPage, setApprovalPage] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const dateIssue = filters.start && filters.end && filters.start > filters.end ? "Enter an end date on or after the start date." : "";
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ view: "activity", ...applied, page: String(page), approvalPage: String(approvalPage) });
    setBusy(true);
    setError("");
    api<ActivityData>(`/api/profile?${query}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setActivity(result);
    }).catch(error => {
      if (controller.signal.aborted) return;
      handleError(error);
      setError(message(error));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [applied, page, approvalPage]);
  const paginated = (selected: number, count: number, size: number, set: (next: number) => void, label: string) =>
    count > size && <nav className="profile-actions pagination" aria-label={label}>
      <button type="button" className="button secondary" disabled={busy || selected === 0} onClick={() => set(selected - 1)}>Previous</button>
      <span className="profile-meta" role="status">Page {selected + 1} of {Math.ceil(count / size)}</span>
      <button type="button" className="button secondary" disabled={busy || (selected + 1) * size >= count} onClick={() => set(selected + 1)}>Next</button>
    </nav>;
  return <>
    <section className="profile-card settings-card">
      <h2>Audit log</h2>
      <p className="profile-meta">Activity is recorded from real workspace actions. Date filters use UTC.</p>
      <form onSubmit={event => { event.preventDefault(); if (!dateIssue) { setPage(0); setApplied({ ...filters }); } }}>
        <div className="audit-filters">
          <label>Action type<select value={filters.action} onChange={event => setFilters({ ...filters, action: event.target.value })}>
            <option value="">All actions</option>{Object.entries(auditActions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label>From <input type="date" value={filters.start} onChange={event => setFilters({ ...filters, start: event.target.value })} /></label>
          <label>To <input type="date" value={filters.end} aria-invalid={Boolean(dateIssue) || undefined} aria-describedby="date-issue"
            onChange={event => setFilters({ ...filters, end: event.target.value })} /></label>
          <button className="button secondary" disabled={Boolean(dateIssue)}>Apply filters</button>
        </div>
        <p id="date-issue" className="field-issue" aria-live="polite">{dateIssue}</p>
      </form>
      {busy && <p role="status">Loading activity…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {activity && !busy && <>{activity.activity.events.length ? <div className="profile-table audit-table" role="table" aria-label="Audit log">
        <div role="row" className="table-head table-row">{["Time", "Action", "Target", "OCR mode", "Status"].map(title =>
          <span role="columnheader" key={title}>{title}</span>)}</div>
        {activity.activity.events.map(row => <div className="table-row" role="row" key={row.id}>
          <div role="cell"><span className="mobile-cell-label" aria-hidden="true">Time</span>
            <time title={row.occurred_at} dateTime={row.occurred_at}>{profileDate(row.occurred_at, session.personal)}</time></div>
          <div role="cell"><span className="mobile-cell-label" aria-hidden="true">Action</span>{auditActions[row.action]}</div>
          <div role="cell"><span className="mobile-cell-label" aria-hidden="true">Target</span>{row.target ?? "—"}</div>
          <div role="cell"><span className="mobile-cell-label" aria-hidden="true">OCR mode</span>
            {row.ocr_mode === "external" ? "External cloud" : row.ocr_mode === "local" ? "Local" : "—"}</div>
          <div role="cell"><span className="mobile-cell-label" aria-hidden="true">Status</span><RunStatus status={row.status} /></div>
        </div>)}
      </div> : <p>No activity matches this view.</p>}
        {paginated(page, activity.activity.count, 20, setPage, "Audit log pages")}</>}
      <ExportButton key={JSON.stringify(applied)} type="activity" filters={applied} handleError={handleError} />
    </section>
    <section className="profile-card settings-card">
      <h2>External OCR approvals</h2>
      {activity && !busy && <>{activity.approvals.events.length ? <ul className="approval-list">{activity.approvals.events.map(row =>
        <li key={row.id}><strong>{row.target}</strong><time title={row.occurred_at} dateTime={row.occurred_at}>
          {profileDate(row.occurred_at, session.personal)}</time></li>)}</ul> : <p>No PDFs have been approved for external OCR.</p>}
        {paginated(approvalPage, activity.approvals.count, 10, setApprovalPage, "External OCR approvals pages")}</>}
    </section>
  </>;
}
