"use client";

import { useEffect, useRef, useState } from "react";
import { Arrow } from "./marks";

export function Reveals() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-revealed", "");
        observer.unobserve(entry.target);
      }
    }, { threshold: .12 });
    const groups = document.querySelectorAll("[data-reveal]");
    groups.forEach(group => observer.observe(group));
    return () => observer.disconnect();
  }, []);

  return null;
}

export function FinalCallToAction() {
  const section = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      element.dataset.visible = String(entry.intersectionRatio >= .25);
    }, { threshold: .25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const action = paused ? "Play logo and grid animation" : "Pause logo and grid animation";
  return <section className="market-final market-band market-grid" aria-labelledby="final-title"
    ref={section} data-paused={paused}>
    <div className="market-wrap final-layout">
      <svg id="final-mark" className="final-mark" viewBox="0 0 256 256" width="256" height="256" aria-hidden="true">
        <rect width="256" height="256" rx="56" fill="#08242B" />
        <path d="M64 200 L128 58 L192 200" fill="none" stroke="#F4F1E8" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
        <g className="final-eye">
          <path d="M104 152 Q128 130 152 152 Q128 174 104 152Z" fill="#F2B544" />
          <circle className="final-pupil" cx="128" cy="152" r="7" fill="#08242B" />
        </g>
        <g className="final-signal" fill="#1FA8A0">
          <rect x="64" y="214" width="34" height="9" rx="4.5" />
          <rect x="111" y="214" width="34" height="9" rx="4.5" />
          <rect x="158" y="214" width="34" height="9" rx="4.5" />
        </g>
      </svg>
      <div className="final-copy">
        <h2 id="final-title">See where your next rate comes from.</h2>
        <div className="hero-actions">
          <a className="market-button market-primary" href="/sign-in">Sign in <Arrow /></a>
          <a className="market-link" href="/example">Open an example</a>
          <button className="market-button cycle-button final-motion-toggle" type="button" aria-label={action}
            aria-controls="final-mark final-cell" title={action} onClick={() => setPaused(value => !value)}>
            <span aria-hidden="true" className={paused ? "cycle-play" : "cycle-pause"} />
          </button>
        </div>
      </div>
    </div>
    <span id="final-cell" className="final-cell" aria-hidden="true" />
  </section>;
}

export function ReadingDemo() {
  const demo = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (demo.current) demo.current.dataset.visible = String(entry.isIntersecting);
    });
    if (demo.current) observer.observe(demo.current);
    return () => observer.disconnect();
  }, []);

  return <div className="reading-demo" ref={demo} data-paused={paused}>
    <div className="reading-illustration" aria-hidden="true">
      <svg className="demo-eye" viewBox="0 0 64 48" width="64" height="48" fill="none">
        <path d="M3 24Q32-11 61 24Q32 59 3 24Z" stroke="currentColor" strokeWidth="2" />
        <rect x="26" y="18" width="12" height="12" rx="2" fill="currentColor" />
      </svg>
      <div className="demo-pages">
        {[1, 2, 3, 4].map(page => <span key={page}><i /><i /><i /></span>)}
      </div>
    </div>
    <button type="button" className="market-button reading-toggle" onClick={() => setPaused(value => !value)}>
      {paused ? "Play" : "Pause"}<span className="market-sr"> reading animation</span>
    </button>
  </div>;
}
