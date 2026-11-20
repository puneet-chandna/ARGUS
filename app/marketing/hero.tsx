"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { CitationChip } from "../citation-chip";
import type { previews as data } from "./examples";
import { Arrow } from "./marks";

type Preview = typeof data[number];
type PanelMotion = "pending" | "intro" | "switch" | "idle";
const fieldLabel: Record<string, string> = {
  rto: "RTO", fuel: "Fuel", engine_cc: "Engine (cc)", model: "Model", current_ncb: "Current NCB",
};
const labels = { resolved: "Resolved", ambiguous: "Needs review", unsupported: "Unsupported" };

function AnimatedRate({ rate, animate }: { rate: string | number; animate: boolean }) {
  const output = useRef<HTMLSpanElement>(null);
  const target = Number(rate);
  const decimals = String(rate).split(".")[1]?.length ?? 0;
  useEffect(() => {
    const digits = output.current;
    if (!animate || !digits) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      digits.textContent = String(rate);
      return;
    }
    const started = performance.now() + 350;
    const step = (now: number) => {
      const progress = Math.max(0, Math.min((now - started) / 780, 1));
      digits.textContent = (target * (1 - (1 - progress) ** 2)).toFixed(decimals);
      if (progress < 1) id = requestAnimationFrame(step);
    };
    let id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [rate, animate, target, decimals]);

  return <strong className="hero-rate">
    <span className="market-sr">{rate}%</span>
    <span className="hero-rate-number" aria-hidden="true">
      <span className="hero-rate-digits">
        <span className="hero-rate-static">{rate}</span>
        {animate && Number.isFinite(target) && <span className="hero-rate-count" ref={output}>{(0).toFixed(decimals)}</span>}
      </span><small>%</small>
    </span>
    <span className="hero-rate-preparing" aria-hidden="true">Preparing example</span>
  </strong>;
}

function PreviewPanel({ example, motion }: { example: Preview; motion: PanelMotion }) {
  const playing = motion === "intro" || motion === "switch";
  return <div className="hero-panel" data-motion={motion} data-playing={playing}>
    <div className="hero-policy">
      <div className="hero-policy-id"><span>Policy schedule</span><span>{example.coverage}</span></div>
      <dl>
        {example.fields.map(({ key, value, page }) => <div key={key}>
          <dt>{fieldLabel[key]}{page ? <>
            <span className="field-page" aria-hidden="true">p{page}</span>
            <span className="market-sr">, page {page}</span>
          </> : null}</dt>
          <dd>{value}</dd>
        </div>)}
      </dl>
    </div>
    <div className="hero-outcome">
      <div className="hero-outcome-top">
        <span>{example.component}</span>
        <span className="market-state" data-state={example.status}>{labels[example.status]}</span>
      </div>
      {example.rate != null ? <div className="hero-rate-line">
        <AnimatedRate rate={example.rate} animate={playing} />
        {example.other && <span>{example.other}</span>}
      </div> : <p className="hero-reason">{example.reason}</p>}
      {example.unsupported && <p className="hero-secondary-outcome">
        <span>TP unsupported.</span> {example.unsupported}
      </p>}
    </div>
    <div className="hero-cite">
      <span className="hero-cite-meta">Rate card</span>
      {example.citation && <CitationChip className="hero-cell" label={example.citation.text}
        source={`${example.citation.file} · ${example.citation.text}`} />}
      <span className="hero-cite-file">{example.citation?.file}</span>
    </div>
    <a className="market-link hero-trace" href={`/example/${example.slug}`}>Open decision trace <Arrow /></a>
  </div>;
}

export function Hero({ examples }: { examples: Preview[] }) {
  const [index, setIndex] = useState(0);
  const [motion, setMotion] = useState<PanelMotion>("pending");
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [outOfView, setOutOfView] = useState(true);
  const [visible, setVisible] = useState(true);
  const tabs = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      const inView = entry.intersectionRatio >= .25;
      setOutOfView(!inView);
      if (inView) {
        const waitingRate = card.current?.querySelector('.hero-panel[data-motion="pending"] .hero-rate-number');
        // Preserve the result if a long wait already revealed the static fallback.
        const next = waitingRate && getComputedStyle(waitingRate).visibility === "hidden" ? "intro" : "idle";
        setMotion(current => current === "pending" ? next : current);
      }
    }, { threshold: .25 });
    if (card.current) observer.observe(card.current);
    function visibility() { setVisible(!document.hidden); }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  function select(next: number, enableMotion: boolean) {
    setIndex(next);
    setMotion(enableMotion ? "switch" : "idle");
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? examples.length - 1 :
      event.key === "ArrowRight" ? (index + 1) % examples.length :
      event.key === "ArrowLeft" ? (index + examples.length - 1) % examples.length : null;
    if (next == null) return;
    event.preventDefault();
    select(next, false);
    tabs.current?.querySelectorAll("button")[next]?.focus();
  }

  const cycling = !paused && !hover && !focus && !outOfView && visible;
  return <section className="market-hero market-grid" aria-labelledby="entry-title">
    <div className="market-wrap hero-layout">
      <div className="hero-copy">
        <h1 id="entry-title">Motor<br className="hero-lead-break" />{" "}brokerage<br />{" "}you can <em>trace.</em></h1>
        <p className="hero-subhead">
          Upload a motor policy and see the brokerage decision, the policy facts behind it, and the insurer’s exact rate-card citation.
          <a href="#example-citation" aria-label="1. Go Digit rate-card citation" className="hero-footnote" onClick={() => {
            setPaused(true);
            select(0, false);
            requestAnimationFrame(() => document.getElementById("example-citation")?.querySelector("button")?.focus({ preventScroll: true }));
          }}>¹</a>
        </p>
        <div className="hero-actions">
          <a className="market-button market-primary" href="/sign-in">Sign in to Argus <Arrow /></a>
          <a className="market-link" href="#worked-example" onClick={() => {
            setPaused(true);
            select(0, false);
          }}>See a worked example</a>
        </div>
        <p className="hero-note">Built for the Vaatun Insurance Rater Agent Challenge.</p>
      </div>
      <section className="hero-example market-card" id="worked-example" tabIndex={-1} aria-labelledby="worked-title" data-motion={motion}
        ref={card} onPointerEnter={event => { if (event.pointerType === "mouse") setHover(true); }}
        onPointerLeave={() => setHover(false)} onPointerDown={event => {
          if (event.pointerType === "touch" && !(event.target as Element).closest(".cycle-button")) setPaused(true);
        }}
        onFocus={() => setFocus(true)} onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
        }}>
        <div className="hero-example-head">
          <h2 id="worked-title">Worked example <span>Synthetic policy</span></h2>
          <button type="button" className="market-button cycle-button" onClick={() => setPaused(value => !value)}>
            <span aria-hidden="true" className={paused ? "cycle-play" : "cycle-pause"} />
            {paused ? "Play" : "Pause"}<span className="market-sr"> example rotation</span>
          </button>
        </div>
        <div className="hero-tab-wrap">
          <div ref={tabs} className="hero-tabs" role="tablist" aria-label="Challenge policies" onKeyDown={navigate}
            style={{ "--active-tab": index } as CSSProperties}>
            {examples.map((example, i) => <button type="button" role="tab" id={`demo-tab-${i}`} key={example.slug}
              aria-controls={`demo-panel-${i}`} aria-selected={index === i} tabIndex={index === i ? 0 : -1}
              onClick={event => { if (i !== index) select(i, event.detail > 0); }}>{example.name}</button>)}
          </div>
        </div>
        <div className="cycle-segments" aria-hidden="true" data-playing={cycling}>
          {examples.map((example, i) => <span key={example.slug} data-segment={i < index ? "past" : i === index ? "active" : "future"}>
            {i === index && <i key={index} onAnimationEnd={() => select((index + 1) % examples.length, true)} />}
          </span>)}
        </div>
        <div id="example-citation" className="hero-panels">
          {examples.map((example, i) => <div role="tabpanel" tabIndex={0} key={example.slug} id={`demo-panel-${i}`}
            inert={index !== i} hidden={index !== i} aria-labelledby={`demo-tab-${i}`}>
            <PreviewPanel key={index === i ? "active" : "rest"} example={example} motion={index === i ? motion : "idle"} />
          </div>)}
        </div>
      </section>
    </div>
  </section>;
}
