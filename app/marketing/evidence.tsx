"use client";

import { useEffect, useRef, useState } from "react";
import result from "./result.webp";
import resultSmall from "./result-small.webp";

const callouts = [
  { key: "rate", title: "The rate", text: "Go Digit resolves third-party brokerage at 29.5%. Own damage is inapplicable on this stand-alone TP policy." },
  { key: "cell", title: "The cell", text: "The 4W SATP row cites B293:E293 in the Go Digit workbook." },
  { key: "page", title: "The page", text: "The start date cites page 1 of the synthetic policy. The RTO, fuel, and engine capacity cite the same page." },
];

export function Evidence() {
  const [active, setActive] = useState("rate");
  const calloutList = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const centered = entries.find(entry => entry.isIntersecting);
      const key = centered?.target.getAttribute("data-region");
      if (key && !calloutList.current?.contains(document.activeElement)) setActive(key);
    }, { rootMargin: `${-Math.round(innerHeight * .26)}px 0px ${-Math.round(innerHeight * .36)}px 0px` });
    calloutList.current?.querySelectorAll("button").forEach(button => observer.observe(button));
    return () => observer.disconnect();
  }, []);

  return <div className="evidence-layout">
    <div className="evidence-rail">
      <p className="market-eyebrow">02 / Evidence</p>
      <h2>Every number points back to a page.</h2>
      <div className="evidence-callouts" ref={calloutList}>
        {callouts.map(({ key, title, text }, index) => <button key={key} type="button" data-region={key}
          aria-pressed={active === key} aria-controls="result-preview" onFocus={() => setActive(key)} onClick={() => setActive(key)}>
          <span className="callout-index" aria-hidden="true">0{index + 1}</span>
          <span><strong>{title}</strong><span>{text}</span></span>
        </button>)}
      </div>
      <a className="market-link" href="/example/go-digit">Inspect the Go Digit decision <span aria-hidden="true">↗</span></a>
    </div>
    <figure className="evidence-figure market-card">
      <figcaption><span>Argus result screen</span><span>Go Digit · Synthetic policy</span></figcaption>
      <div className="evidence-image" id="result-preview" data-region={active}>
        {/* The adjacent text gives a readable equivalent for the annotated image. */}
        <img src={result.src} width={result.width} height={result.height} loading="lazy" decoding="async"
          srcSet={`${resultSmall.src} ${resultSmall.width}w, ${result.src} ${result.width}w`}
          sizes="(max-width: 600px) calc(100vw - 64px), (max-width: 820px) 650px, (max-width: 1464px) 51vw, 760px"
          alt="The Argus Go Digit report shows the TP rate, the workbook citation, and the policy page citation in the decision trace." />
        {callouts.map(({ key }) => <span aria-hidden="true" key={key} className={`evidence-ring ring-${key}`} />)}
      </div>
    </figure>
  </div>;
}
