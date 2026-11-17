import "../desk.css";
import "../profile.css";

export default function PrivacyPage() {
  return <div className="app-frame" data-view="workspace">
    <main className="work">
      <div className="profile-content">
        <a href="/profile/data">← Data &amp; privacy</a>
        <h1>Privacy policy</h1>
        <p>Argus saves your account details, preferences, private policy PDFs, analyses and workspace activity. Saved data is available to your account. You can export structured data or delete saved runs or your account from Data &amp; privacy.</p>
        <p>Argus asks for approval each time before sending policy pages to external OCR services. Only approve synthetic or de-identified policies that you’re authorized to share. External services handle those pages under their own terms.</p>
      </div>
    </main>
  </div>;
}
