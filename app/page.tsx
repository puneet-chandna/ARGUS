import type { Metadata } from "next";
import { Hero } from "./marketing/hero";
import { Navigation } from "./marketing/navigation";
import { Arrow, Monogram } from "./marketing/marks";
import { Evidence } from "./marketing/evidence";
import { FinalCallToAction, ReadingDemo, Reveals } from "./marketing/motion";
import { citationLabel, examples, gridCitation, previews } from "./marketing/examples";
import { CitationChip } from "./citation-chip";
import "./marketing/marketing.css";

const project = "https://github.com/puneet-chandna/ARGUS";
const challenge = "https://solvetojoin.vaatun.com/";
const [digit, hdfc] = examples;
const digitCite = gridCitation(digit)!;
const hdfcCite = gridCitation(hdfc)!;
const unsupportedCite = hdfc.report.trace.find(step => step.step === hdfc.report.tp.reason)!.sources[0];

const faq = [
  ["What does Needs review mean?", "An input is missing or conflicting, or the evidence cannot establish a unique rate. The trace shows the blocker. Where a policy fact can be verified, you can confirm it and recalculate."],
  ["When does Argus say Unsupported?", "When the supplied rate card excludes the case or does not publish a rate for the applicable cover. A decision can show a supported rate for one cover and an unsupported outcome for the other."],
  ["Does a model pick the rate?", "Models read the policy pages. A deterministic rules engine uses the verified policy facts and the insurer’s rate card to select a rate."],
  ["Where are PDFs and runs stored?", "Original PDFs go in a private Supabase Storage bucket. Run results are saved in Supabase Postgres and scoped to your account. Your retention settings control when saved files or runs are removed."],
  ["Which insurers does it support today?", `${examples.map(example => example.name).join(", ")}. Coverage varies by the supplied rate card and policy type.`],
] as const;

export const metadata: Metadata = {
  title: "Argus · Motor brokerage you can trace",
  description: "Review motor policy brokerage with source-backed policy facts, insurer rate-card citations, and decision traces.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    title: "Argus · Motor brokerage you can trace",
    description: "Review motor policy brokerage with policy facts and insurer rate-card citations.",
    url: "/",
    images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: "Argus monogram and rate grid with a cited cell" }],
  },
};

export default function LandingPage() {
  return <div className="marketing landing-page">
    <a className="skip-link" href="#main">Skip to main content</a>
    <Navigation />
    <main id="main" tabIndex={-1}>
      <Hero examples={previews} />

      <section className="market-band market-section" id="how-it-works" tabIndex={-1} aria-labelledby="workflow-title">
        <div className="market-wrap">
          <p className="market-eyebrow">01 / How it works</p>
          <h2 id="workflow-title">How a review works.</h2>
          <ol className="workflow-steps" data-reveal>
            <li>
              <div className="workflow-visual upload-visual">
                <div className="sample-dropzone">
                  <svg width="24" height="24" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="1.5" aria-hidden="true">
                    <path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" />
                  </svg>
                  <strong>Upload a policy PDF</strong>
                  <span className="sample-filename">{previews[0].filename}</span>
                </div>
                <span className="sample-chip verified">Matching cache</span>
              </div>
              <h3>Upload the policy</h3>
              <p>Argus checks whether your account has a matching analysis it can reuse.</p>
            </li>
            <li>
              <div className="workflow-visual source-visual">
                <div className="policy-fragment">
                  <div><span>Policy schedule</span><span>p1</span></div>
                  <dl><dt>RTO</dt><dd>{hdfc.report.fields.rto.value}</dd><dt>Current NCB</dt><dd>{hdfc.report.fields.current_ncb.value}%</dd></dl>
                </div>
                <div className="fragment-footnote">
                  <span>Grid footnote · Zone 2</span>
                  <mark>Eligible GWP excludes stand-alone TP.</mark>
                </div>
              </div>
              <h3>Check the evidence</h3>
              <p>Inspect the policy facts and the grid conditions. Verify any facts the decision still needs.</p>
            </li>
            <li>
              <div className="workflow-visual decision-visual">
                <span className="market-state" data-state="resolved">Resolved</span>
                <div className="mini-decision-rate"><strong>{digit.report.tp.rate}%</strong><span>Third party</span></div>
                <CitationChip className="mini-cite" label={citationLabel(digitCite)} source={`${digitCite.file} · ${citationLabel(digitCite)}`} />
              </div>
              <h3>Open the decision</h3>
              <p>See the brokerage for each cover, or the reason Argus left it undetermined.</p>
            </li>
          </ol>
        </div>
      </section>

      <section className="market-section evidence-section" id="evidence" tabIndex={-1} aria-label="Evidence">
        <div className="market-wrap"><Evidence /></div>
      </section>

      <section className="market-band market-section" id="outcomes" tabIndex={-1} aria-labelledby="outcomes-title">
        <div className="market-wrap">
          <p className="market-eyebrow">03 / Outcomes</p>
          <h2 id="outcomes-title">Argus answers only when the rate card does.</h2>
          <div className="outcome-grid" data-reveal>
            <article className="market-card outcome-resolved">
              <span className="market-state" data-state="resolved">Resolved</span>
              <h3>Go Digit</h3>
              <p className="outcome-number">{digit.report.tp.rate}% <span>Third party</span></p>
              <a className="market-link" href="/example/go-digit">See the matched row <Arrow /></a>
            </article>
            <article className="market-card outcome-review">
              <span className="market-state" data-state="ambiguous">Needs review</span>
              <h3>HDFC ERGO · Own damage</h3>
              <p>Zone 2 is established. The eligible private-car GWP is needed to choose the OD slab.</p>
              <CitationChip className="mini-cite" label={citationLabel(hdfcCite)} source={`${hdfcCite.file} · ${citationLabel(hdfcCite)}`} />
            </article>
            <article className="market-card outcome-unsupported">
              <span className="market-state" data-state="unsupported">Unsupported</span>
              <h3>HDFC ERGO · Third party</h3>
              <p>{hdfc.report.tp.reason}</p>
              <CitationChip className="mini-cite" label={citationLabel(unsupportedCite)} source={`${unsupportedCite.file} · ${citationLabel(unsupportedCite)}`} />
            </article>
          </div>
        </div>
      </section>

      <section className="market-section" id="speed" aria-labelledby="speed-title">
        <div className="market-wrap">
          <p className="market-eyebrow">04 / Speed and care</p>
          <h2 id="speed-title">Reuse a reading. Or start a new one.</h2>
          <div className="speed-panel market-card" data-reveal>
            <article>
              <span className="sample-chip verified">Matching cache</span>
              <h3>Seen this PDF before?</h3>
              <p>On a cache hit, Argus reuses the verified reading and skips external OCR.</p>
              <div className="cached-file"><span className="checked-file" aria-hidden="true">✓</span><span><strong>From saved analysis</strong><small>{previews[0].filename}</small></span></div>
            </article>
            <article>
              <span className="sample-chip">Live OCR</span>
              <h3>New PDF</h3>
              <p>With approval, Argus reads the policy page by page and shows its progress.</p>
              <ReadingDemo />
            </article>
          </div>
        </div>
      </section>

      <section className="market-band market-section" id="privacy" tabIndex={-1} aria-labelledby="privacy-title">
        <div className="market-wrap market-split">
          <div><p className="market-eyebrow">05 / Privacy and control</p><h2 id="privacy-title">Control what gets shared and saved.</h2></div>
          <dl className="privacy-rows" data-reveal>
            <div><dt>Approval per PDF</dt><dd>Argus asks before sending policy pages to external OCR.</dd></div>
            <div><dt>Synthetic or de-identified</dt><dd>Use a synthetic policy or remove personal information before uploading.</dd></div>
            <div><dt>Saved to your account</dt><dd>Reopen completed runs from your workspace and manage retention in settings.</dd></div>
            <div><dt>Export a run</dt><dd>Download a run from its result screen.</dd></div>
          </dl>
        </div>
      </section>

      <section className="market-section" id="faq" tabIndex={-1} aria-labelledby="faq-title">
        <div className="market-wrap market-split">
          <div><p className="market-eyebrow">06 / FAQ</p><h2 id="faq-title">Questions about Argus.</h2></div>
          <div className="faq-list">
            {faq.map(([question, answer]) => <details key={question}>
              <summary>{question}<span aria-hidden="true" /></summary>
              <div className="faq-answer"><div><p>{answer}</p></div></div>
            </details>)}
          </div>
        </div>
      </section>

      <FinalCallToAction />
    </main>

    <footer className="market-footer">
      <div className="market-wrap footer-links">
        <div>
          <a className="market-brand" href="/" aria-label="Argus home"><Monogram /> Argus</a>
          <p className="footer-byline">Built by <a href="https://puneetchandna.com/">Puneet Chandna</a> · 2026</p>
        </div>
        <nav aria-label="Product"><h2>Product</h2><a href="/example">Example decision</a><a href="/sign-in">Sign in</a></nav>
        <nav aria-label="Project"><h2>Project</h2><a href={project}>GitHub repo</a><a href={challenge}>Vaatun challenge</a><a href={`${project}#readme`}>README</a></nav>
      </div>
      <div className="brand-strip" aria-hidden="true" />
    </footer>
    <Reveals />
  </div>;
}
