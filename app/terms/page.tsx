import "../desk.css";
import "../profile.css";

export default function TermsPage() {
  return <div className="app-frame" data-view="workspace">
    <main className="work">
      <div className="profile-content">
        <a href="/profile/data">← Data &amp; privacy</a>
        <h1>Terms</h1>
        <p>Use Argus only for motor insurance documents you’re authorized to process. Do not approve external OCR for identifiable or unauthorized material.</p>
        <p>Review the quoted policy facts and the cited rate card before acting on any result. An unsupported or ambiguous decision does not provide a commission rate.</p>
      </div>
    </main>
  </div>;
}
