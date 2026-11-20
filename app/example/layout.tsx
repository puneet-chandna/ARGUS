import type { ReactNode } from "react";
import { examples } from "../marketing/examples";
import { Monogram } from "../marketing/marks";
import "../desk.css";
import "../reading-eye.css";
import "../marketing/marketing.css";

export default function ExampleLayout({ children }: { children: ReactNode }) {
  return <div className="marketing example-shell">
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="example-mast">
      <div className="market-wrap">
        <a className="market-brand" href="/" aria-label="Argus home"><Monogram /> Argus</a>
        <nav aria-label="Example navigation"><a href="/example">Example decisions</a><a href="/sign-in">Sign in</a></nav>
      </div>
    </header>
    <p className="example-ribbon">Read-only example. <a href="/sign-in">Sign in to analyze your own PDF.</a></p>
    <main className="market-wrap example-main" id="main" tabIndex={-1}>
      <nav className="example-policies" aria-label="Challenge policies">
        {examples.map(example => <a key={example.slug} href={`/example/${example.slug}`}>{example.name}</a>)}
      </nav>
      {children}
    </main>
  </div>;
}
