"use client";

import { useEffect, useRef, useState } from "react";

export function CitationChip({ label, source, className }: { label: string; source: string; className?: string }) {
  const [message, setMessage] = useState("");
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);

  async function copy() {
    let next: string;
    try {
      await navigator.clipboard.writeText(source);
      next = "Copied";
    } catch {
      next = "Copy unavailable";
    }
    if (timeout.current) clearTimeout(timeout.current);
    setMessage(next);
    timeout.current = setTimeout(() => setMessage(""), 1200);
  }

  return <span className={`citation-copy ${className ?? ""}`}>
    <button className="citation-copy-button" type="button" onClick={copy} aria-label={`Copy citation: ${label}`}>
      {label}
    </button>
    <span className="citation-copy-feedback" role="status">{message}</span>
  </span>;
}
