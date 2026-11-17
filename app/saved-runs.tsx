import { useEffect, useRef, useState } from "react";
import { RunStatus } from "./report";
import { commissionLabel, profileDate, type Personal, type Preferences } from "../lib/profile-settings";
import type { Run } from "./report";



export function SavedRun({ run, current, onOpen, onManage, personal, preferences }: {
  run: Run; current: boolean; onOpen: () => void; onManage: () => void; personal?: Personal; preferences?: Preferences;
}) {
  const row = useRef<HTMLLIElement>(null);
  const [detail, setDetail] = useState<Run>();
  const { id, revision } = run;
  const needsDetail = run.status === "complete" && !run.result && !run.deleting_at && !run.display_name;

  useEffect(() => {
    if (!needsDetail || detail?.revision === revision || !row.current) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      // The history endpoint omits result fields. Read detail only for rows in view.
      fetch(`/api/runs/${id}`, { cache: "no-store", signal: controller.signal })
        .then(async response => {
          if (!response.ok) return;
          const { run }: { run: Run } = await response.json();
          if (!controller.signal.aborted) setDetail(run);
        }).catch(() => {}); // The summary remains useful if detail is unavailable.
    });
    observer.observe(row.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [detail?.revision, id, needsDetail, revision]);

  const report = run.result ?? (detail?.revision === revision ? detail.result : null);
  const fact = (name: string) => {
    const field = report?.fields[name];
    return field?.status === "accepted" || field?.status === "confirmed_by_reviewer" ? field.value : null;
  };
  const vehicle = [fact("make"), fact("model")].filter(Boolean).join(" ");
  const rates = (["od", "tp"] as const).flatMap(key => {
    const rate = report?.[key].rate;
    return rate == null ? [] : [`${key.toUpperCase()} ${commissionLabel(rate, preferences)}`];
  }).join(" / ");
  const status = run.deleting_at ? "deleting" : run.decision ?? report?.status ?? run.status;
  const title = run.display_name || [fact("insurer"), vehicle || fact("policy_type"), rates].filter(Boolean).join(" · ") ||
    (status === "resolved" ? "Commission determined" : status === "unsupported" ? "Outside rate card coverage" :
      status === "ambiguous" ? "Commission undetermined" : run.filename.replace(/\.pdf$/i, ""));
  const created = new Date(run.created_at);

  return <li ref={row} className="history-row" data-current={current}>
    <button className="history-item" type="button" aria-current={current || undefined} onClick={onOpen}>
      <strong>{title}</strong>
      <time dateTime={run.created_at} title={created.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "long", timeZone: personal?.time_zone ?? undefined })}>{profileDate(run.created_at, personal)}</time>
      <span className="run-meta"><RunStatus status={status} />{run.pinned && <span>Pinned</span>}</span>
      <span className="history-filename">{run.filename}</span>
    </button>
    <button type="button" className="history-manage" aria-label="Run actions"
      disabled={run.status === "processing" && Date.parse(run.lease_until ?? "") > Date.now()}
      onClick={onManage}>
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <circle cx="10" cy="4" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="10" cy="16" r="1.5" />
      </svg>
    </button>
  </li>;
}
