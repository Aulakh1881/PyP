"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Mode = "sign-in" | "sign-up";

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
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    const supabase = createClient();
    const result =
      mode === "sign-in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (result.error) {
      setError(result.error.message);
    } else if (mode === "sign-up") {
      setMessage("Check your email to confirm your account, then sign in.");
      setMode("sign-in");
    } else {
      window.location.href = "http://localhost:8080/app/?authenticated=1";
    }

    setBusy(false);
  }

  return (
    <main className="signin">
      <section className="signcard" aria-labelledby="auth-title">
        <Link className="signin-figure-link" href="/" aria-label="Pyp home"><PypFigure /></Link>
        <h1 id="auth-title">{mode === "sign-in" ? "Sign in to Pyp" : "Create your Pyp account"}</h1>
        <p className="muted">
          {mode === "sign-in"
            ? "The dashboard for Maya’s Ceramics, a demo PayPal sandbox business."
            : "Create an account to access your Pyp dashboard."}
        </p>

        <div className="auth-tabs" role="tablist" aria-label="Account access">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "sign-in"}
            className={mode === "sign-in" ? "active" : ""}
            onClick={() => setMode("sign-in")}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "sign-up"}
            className={mode === "sign-up" ? "active" : ""}
            onClick={() => setMode("sign-up")}
          >
            Sign up
          </button>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={6}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button className="btn auth-submit" type="submit" disabled={busy}>
            {busy ? "Working..." : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>

        {message && <p className="auth-message" role="status">{message}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <p className="hint">
          Independent concept · Sandbox only · Not affiliated with PayPal
        </p>
      </section>
    </main>
  );
}
