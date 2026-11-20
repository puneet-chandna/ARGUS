import { Arrow, Monogram } from "./marketing/marks";
import "./marketing/marketing.css";

export default function NotFound() {
  return <main className="marketing market-not-found" id="main">
    <Monogram halfClosed />
    <h1>Cell not found.</h1>
    <p>The page you requested is unavailable.</p>
    <a className="market-button market-primary" href="/">Back to Argus <Arrow /></a>
  </main>;
}
