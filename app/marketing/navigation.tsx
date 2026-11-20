"use client";

import { useEffect, useRef } from "react";
import { runHash } from "../../lib/profile-settings";
import { Monogram } from "./marks";

const sections = [
  ["How it works", "#how-it-works"], ["Evidence", "#evidence"], ["Outcomes", "#outcomes"],
  ["Privacy", "#privacy"], ["FAQ", "#faq"],
];

export function Navigation() {
  const header = useRef<HTMLElement>(null);
  const progress = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const failed = url.searchParams.get("auth") === "confirmation_failed";
    const hash = runHash.test(url.hash) ? url.hash : "";
    if (failed || url.searchParams.get("view") === "signin") {
      window.location.replace(`/sign-in${failed ? "?auth=confirmation_failed" : ""}${hash}`);
    } else if (hash) {
      window.location.replace(`/workspace${hash}`);
    }

    let frame = 0;
    function update() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const range = document.documentElement.scrollHeight - window.innerHeight;
        if (header.current) header.current.dataset.scrolled = String(window.scrollY > 8);
        if (progress.current) progress.current.style.transform = `scaleX(${range > 0 ? Math.max(0, Math.min(1, window.scrollY / range)) : 0})`;
      });
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    const fine = matchMedia("(pointer: fine) and (prefers-reduced-motion: no-preference)");
    const mark = header.current?.querySelector<SVGElement>(".monogram-pupil");
    let frame = 0;
    let x = 0;
    let y = 0;
    function move(event: PointerEvent) {
      if (!fine.matches || event.pointerType !== "mouse") return;
      x = event.clientX / window.innerWidth - .5;
      y = event.clientY / window.innerHeight - .5;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const length = Math.max(.5, Math.hypot(x, y));
        if (mark) mark.style.transform = `translate(${x / length * 6}px, ${y / length * 6}px)`;
      });
    }
    function reset() {
      cancelAnimationFrame(frame);
      frame = 0;
      mark?.style.removeProperty("transform");
    }
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    fine.addEventListener("change", reset);
    return () => {
      reset();
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", reset);
      fine.removeEventListener("change", reset);
    };
  }, []);

  const closeSheet = () => sheet.current?.close();

  return <header className="market-nav" ref={header}>
    <div className="market-wrap nav-inner">
      <a className="market-brand" href="/" aria-label="Argus home"><Monogram /> Argus</a>
      <nav className="nav-sections" aria-label="Primary">
        {sections.map(([label, href]) => <a key={href} href={href}>{label}</a>)}
      </nav>
      <div className="nav-actions">
        <a className="nav-example" href="/example">Example decision</a>
        <a className="market-button nav-signin" href="/sign-in">Sign in</a>
        <button className="market-button menu-trigger" aria-label="Open menu" aria-haspopup="dialog" aria-controls="market-menu"
          type="button" onClick={() => sheet.current?.showModal()}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M3 8h18M3 16h18" />
          </svg>
        </button>
      </div>
    </div>
    <div className="nav-progress" aria-hidden="true"><div className="brand-strip" ref={progress} /></div>
    <dialog className="market-menu" id="market-menu" ref={sheet} aria-labelledby="market-menu-title" onClick={event => {
      if (event.target === event.currentTarget) closeSheet();
    }}>
      <div className="menu-inner">
        <div className="menu-head"><h2 id="market-menu-title">Menu</h2>
          <button className="market-button" type="button" onClick={closeSheet}>Close</button>
        </div>
        <nav aria-label="Mobile">
          {sections.map(([label, href]) => <a key={href} href={href} onClick={() => {
            closeSheet();
            requestAnimationFrame(() => document.querySelector<HTMLElement>(href)?.focus({ preventScroll: true }));
          }}>{label}</a>)}
          <a href="/example" onClick={closeSheet}>Example decision</a>
          <a href="/sign-in" onClick={closeSheet}>Sign in</a>
        </nav>
      </div>
    </dialog>
  </header>;
}
