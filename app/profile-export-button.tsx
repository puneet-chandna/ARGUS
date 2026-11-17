"use client";
import { useEffect, useState } from "react";
import { json, message, RequestError } from "./client-api";

export function ExportButton({ type, filters, runId, handleError }: {
  type: "activity" | "data" | "run"; filters?: { action: string; start: string; end: string }; runId?: string;
  handleError?: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setURL] = useState("");
  const [error, setError] = useState("");
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const label = type === "data" ? "ZIP" : type === "activity" ? "CSV" : "JSON";
  const filename = type === "data" ? "argus-data.zip" : type === "activity" ? "argus-activity.csv" : "argus-run.json";
  return <div className="export-control">
    <div className="profile-actions">
      <button type="button" className={`button ${type === "run" ? "secondary" : "primary"}`} disabled={busy} onClick={async () => {
        setBusy(true); setURL(""); setError("");
        try {
          const result = await fetch("/api/profile/export", json("POST", { type, runId, ...filters }));
          if (!result.ok) throw new RequestError((await result.json()).error, result.status);
          setURL(URL.createObjectURL(await result.blob()));
        } catch (error) { handleError?.(error); setError(message(error)); }
        finally { setBusy(false); }
      }}>{busy ? "Preparing export…" : type === "data" ? "Prepare ZIP" : type === "activity" ? "Export CSV" : "Export run"}</button>
      {url && <a className="button secondary" href={url} download={filename}>Download {label}</a>}
    </div>
    <p className="profile-meta" role="status">{busy ? "Preparing your download." : url ? "Your export is ready to download." : ""}</p>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
