import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Run } from "./report";

export function RunSettings({ run, onClose, onSave, onDelete }: {
  run: Run;
  onClose: () => void;
  onSave: (displayName: string, pinned: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    if (confirmDelete || run.deleting_at) cancel.current?.focus();
    else name.current?.focus();
  }, [confirmDelete, run.deleting_at]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (confirmDelete) await onDelete();
      else await onSave(String(data.get("name") ?? ""), data.get("pinned") === "on");
      dialog.current?.close();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The run could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="run-settings" aria-labelledby="run-settings-title"
    onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <h2 id="run-settings-title">{confirmDelete ? "Delete this run?" : "Manage saved run"}</h2>
    <p>{run.display_name || run.filename}</p>
    <form onSubmit={submit} aria-busy={busy}>
      {confirmDelete ? <p>This permanently removes the analysis and its saved PDF. You can’t undo this.</p>
        : run.deleting_at ? <p>Deletion was interrupted. You can retry it here.</p> : <>
          <label>Run name
            <input ref={name} name="name" defaultValue={run.display_name ?? ""} placeholder={run.filename}
              maxLength={160} disabled={busy} aria-describedby="run-name-hint" />
          </label>
          <p id="run-name-hint">Leave blank to use the original filename.</p>
          <label className="consent"><input type="checkbox" name="pinned" defaultChecked={run.pinned} disabled={busy} />
            Pin to the top of Saved runs
          </label>
        </>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="run-settings-actions">
        {confirmDelete ? <>
          <button ref={cancel} type="button" className="button secondary" disabled={busy}
            onClick={() => { setError(""); setConfirmDelete(false); }}>Cancel deletion</button>
          <button type="submit" className="button danger-button" disabled={busy}>{busy ? "Deleting…" : "Delete run and PDF"}</button>
        </> : <>
          <button type="button" className="button secondary danger-link" disabled={busy}
            onClick={() => { setError(""); setConfirmDelete(true); }}>{run.deleting_at ? "Retry deletion" : "Delete run"}</button>
          <button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          {!run.deleting_at && <button type="submit" className="button primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>}
        </>}
      </div>
    </form>
  </dialog>;
}
