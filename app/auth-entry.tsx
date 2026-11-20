"use client";

import { useState } from "react";
import type { FormEvent, Ref } from "react";
import "./entry.css";

function Arrow({ back = false }: { back?: boolean }) {
  return <svg className={back ? "entry-arrow entry-arrow-back" : "entry-arrow"} width="18" height="18"
    viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

type AuthEntryProps = {
  creatingAccount: boolean;
  confirmationEmail: string;
  email: string;
  busy: boolean;
  error: string;
  notice?: string;
  headingRef: Ref<HTMLHeadingElement>;
  onEmail: (email: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSwitch: () => void;
};

export function AuthEntry({
  creatingAccount, confirmationEmail, email, busy, error, notice, headingRef, onEmail, onSubmit, onSwitch,
}: AuthEntryProps) {
  const [showPassword, setShowPassword] = useState(false);
  const action = creatingAccount ? "Create account" : "Sign in";
  const pendingAction = creatingAccount ? "Creating account…" : "Signing in…";

  function switchMode() {
    setShowPassword(false);
    onSwitch();
  }

  return <div className="public-entry">
    <section className="entry-auth" aria-labelledby="gate-heading">
      <div className="entry-auth-task">
        <a href="/" className="entry-back"><Arrow back /> Back to Argus</a>
        <header>
          <h1 ref={headingRef} id="gate-heading" tabIndex={-1}>
            {confirmationEmail ? "Confirm your email" : creatingAccount ? "Create a reviewer account" : "Sign in to Argus"}
          </h1>
          <p>{confirmationEmail
            ? <>Check <strong>{confirmationEmail}</strong> for a confirmation link to finish setting up your account.</>
            : creatingAccount ? "Create an account to upload policies and save your reviews." : "Open your policy reviews and saved source files."}</p>
        </header>
        {notice && <p className="entry-account-notice" role="status">{notice}</p>}
        {confirmationEmail ? <button className="button primary entry-action" type="button" onClick={switchMode}>Back to sign-in <Arrow /></button> :
          <>
            <form className="entry-auth-form" method="post" onSubmit={onSubmit} aria-busy={busy}>
              <label htmlFor="reviewer-email">Email address</label>
              <input id="reviewer-email" name="email" type="email" autoComplete="username" value={email}
                onChange={event => onEmail(event.target.value)} maxLength={254} required />
              <label htmlFor="reviewer-password">Password</label>
              <div className="entry-password">
                <input id="reviewer-password" key={String(creatingAccount)} name="password" type={showPassword ? "text" : "password"}
                  autoComplete={creatingAccount ? "new-password" : "current-password"} minLength={creatingAccount ? 8 : undefined}
                  maxLength={creatingAccount ? 72 : 1024} required />
                <button type="button" aria-controls="reviewer-password" onClick={() => setShowPassword(value => !value)}>
                  {showPassword ? "Hide" : "Show"}<span className="entry-sr-only"> password</span>
                </button>
              </div>
              {creatingAccount && <p className="entry-field-note">Use at least 8 characters.</p>}
              {error && <p className="error" role="alert">{error}</p>}
              <button className="button primary entry-action" type="submit" disabled={busy}>
                {busy ? pendingAction : action} <Arrow />
              </button>
            </form>
            <p className="entry-auth-switch">
              {creatingAccount ? "Already have an account?" : "New to Argus?"}{" "}
              <button type="button" className="entry-text-link" disabled={busy} onClick={switchMode}>
                {creatingAccount ? "Sign in" : "Create an account"}
              </button>
            </p>
          </>}
      </div>
      <aside className="entry-auth-context" aria-label="About the review workspace">
        <div className="entry-auth-visual" aria-hidden="true">
          <div className="entry-auth-file" />
          <div className="entry-auth-sheet">
            <div className="entry-auth-sheet-header" />
            <div className="entry-auth-sheet-table">
              <i /><i /><i /><i /><i /><i />
            </div>
          </div>
          <span className="entry-auth-folio">p. 1</span>
        </div>
        <div>
          <h2>Pick up where you left off.</h2>
          <p>Original policies and review decisions are saved together in your workspace.</p>
        </div>
      </aside>
    </section>
  </div>;
}
