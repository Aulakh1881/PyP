"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// sign-in / sign-up: the two tabs. forgot: email a reset link. update: set a new
// password after following that link (Supabase signs you in from the link first).
type Mode = "sign-in" | "sign-up" | "forgot" | "update";

const TITLES: Record<Mode, string> = {
  "sign-in": "Sign in to Pyp",
  "sign-up": "Create your Pyp account",
  forgot: "Reset your password",
  update: "Choose a new password",
};

const INTROS: Record<Mode, string> = {
  "sign-in": "The dashboard for Maya’s Ceramics, a demo PayPal sandbox business.",
  "sign-up": "Create an account to access your Pyp dashboard.",
  forgot: "Enter your email and we’ll send you a link to set a new password.",
  update: "Enter a new password for your account.",
};

function PypFigure() {
  return (
    <svg className="signin-figure" viewBox="40 -24 320 380" role="img" aria-label="Pyp">
      <path d="M196 126 C186 90 206 56 254 44 C242 70 244 100 220 126 Z" fill="#FFB020" />
      <path d="M200 118 C292 118 332 180 332 250 C332 316 290 346 200 346 C110 346 68 316 68 250 C68 180 108 118 200 118 Z" fill="#1F6BFF" />
      <path d="M150 242 Q168 222 186 242 M214 242 Q232 222 250 242" stroke="#0B1F4D" strokeWidth="13" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Offer "Resend confirmation email" after a sign-up, or when sign-in says the email isn't confirmed.
  const [canResend, setCanResend] = useState(false);

  // The reset link lands on /login?mode=update. Creating the client reads the code in
  // the link and signs the person in; PASSWORD_RECOVERY confirms it was a reset link.
  useEffect(() => {
    const fromResetLink = new URLSearchParams(window.location.search).get("mode") === "update";
    const { data } = createClient().auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (fromResetLink && session)) setMode("update");
    });
    return () => data.subscription.unsubscribe();
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setMessage("");
    setCanResend(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    const supabase = createClient();
    const origin = window.location.origin;

    if (mode === "sign-in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) return router.push("/paypal-setup");
      setError(error.message);
      setCanResend(/not confirmed/i.test(error.message));
    } else if (mode === "sign-up") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${origin}/login` },
      });
      if (error) {
        setError(error.message);
      } else if (data.session) {
        // Email confirmation is off: the account is ready and already signed in.
        return router.push("/paypal-setup");
      } else {
        setMessage("Check your email to confirm your account, then sign in.");
        setCanResend(true);
        setMode("sign-in");
      }
    } else if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/login?mode=update`,
      });
      if (error) setError(error.message);
      else setMessage("If that email has an account, a reset link is on its way. Open it in this browser.");
    } else {
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) return router.push("/paypal-setup");
      setError(
        /session/i.test(error.message)
          ? "This reset link has expired or was opened in another browser. Ask for a new one."
          : error.message,
      );
    }

    setBusy(false);
  }

  async function resend() {
    if (!email) {
      setError("Enter your email first.");
      return;
    }
    setBusy(true);
    setError("");
    const { error } = await createClient().auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
    if (error) setError(error.message);
    else setMessage("Confirmation email sent again. Check your inbox and spam folder.");
    setBusy(false);
  }

  const tabs = mode === "sign-in" || mode === "sign-up";
  const needsEmail = mode !== "update";
  const needsPassword = mode !== "forgot";
  const submitLabel = {
    "sign-in": "Sign in",
    "sign-up": "Create account",
    forgot: "Send reset link",
    update: "Save new password",
  }[mode];

  return (
    <main className="signin">
      <section className="signcard" aria-labelledby="auth-title">
        <Link className="signin-figure-link" href="/" aria-label="Pyp home"><PypFigure /></Link>
        <h1 id="auth-title">{TITLES[mode]}</h1>
        <p className="muted">{INTROS[mode]}</p>

        {tabs && (
          <div className="auth-tabs" role="tablist" aria-label="Account access">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-in"}
              className={mode === "sign-in" ? "active" : ""}
              onClick={() => switchMode("sign-in")}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-up"}
              className={mode === "sign-up" ? "active" : ""}
              onClick={() => switchMode("sign-up")}
            >
              Sign up
            </button>
          </div>
        )}

        <form className="auth-form" onSubmit={submit}>
          {needsEmail && (
            <>
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </>
          )}
          {needsPassword && (
            <>
              <label htmlFor="password">{mode === "update" ? "New password" : "Password"}</label>
              <input
                id="password"
                type="password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                minLength={6}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </>
          )}
          <button className="btn auth-submit" type="submit" disabled={busy}>
            {busy ? "Working..." : submitLabel}
          </button>
        </form>

        <div className="auth-links">
          {mode === "sign-in" && (
            <button type="button" className="auth-link" onClick={() => switchMode("forgot")}>
              Forgot password?
            </button>
          )}
          {canResend && (mode === "sign-in" || mode === "sign-up") && (
            <button type="button" className="auth-link" onClick={resend} disabled={busy}>
              Resend confirmation email
            </button>
          )}
          {(mode === "forgot" || mode === "update") && (
            <button type="button" className="auth-link" onClick={() => switchMode("sign-in")}>
              Back to sign in
            </button>
          )}
        </div>

        {message && <p className="auth-message" role="status">{message}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <p className="hint">
          Independent concept · Sandbox only · Not affiliated with PayPal
        </p>
      </section>
    </main>
  );
}
