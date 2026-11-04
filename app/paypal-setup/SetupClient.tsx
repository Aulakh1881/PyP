"use client";

import { useState } from "react";

type ConnectionState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "connected"; environment: string }
  | { status: "error"; message: string };

export default function SetupClient() {
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });

  async function checkConnection() {
    setConnection({ status: "checking" });
    try {
      const response = await fetch("/api/paypal/connection", {
        credentials: "include",
        cache: "no-store",
      });
      const body: { connected?: boolean; environment?: string; error?: string } =
        await response.json();

      if (!response.ok || !body.connected) {
        setConnection({
          status: "error",
          message: body.error ?? "The sandbox merchant connection could not be verified.",
        });
        return;
      }

      setConnection({
        status: "connected",
        environment: body.environment ?? "sandbox",
      });
    } catch {
      setConnection({
        status: "error",
        message: "Could not reach Pyp. Make sure the development server is running.",
      });
    }
  }

  if (connection.status === "connected") {
    return (
      <section className="setup-card" aria-live="polite">
        <div className="setup-status setup-status-success">Connected</div>
        <h1>Sandbox merchant connected</h1>
        <p>
          Pyp verified its shared PayPal sandbox Business merchant. This demo
          account supplies the data shown in the dashboard.
        </p>
        <dl className="setup-details">
          <div>
            <dt>Environment</dt>
            <dd>{connection.environment}</dd>
          </div>
          <div>
            <dt>Merchant</dt>
            <dd>Pyp Demo Business</dd>
          </div>
        </dl>
        <a className="btn setup-button" href="http://localhost:8080/app/?authenticated=1">
          Open dashboard
        </a>
      </section>
    );
  }

  return (
    <section className="setup-card">
      <div className="setup-status">Required setup</div>
      <h1>Connect a sandbox PayPal Business account</h1>
      <p>
        Pyp uses a shared PayPal sandbox merchant for this demo. It does not
        collect or store your PayPal password or credentials.
      </p>
      <p className="setup-note">
        This verifies the server-side sandbox connection that powers the demo
        dashboard.
      </p>
      {connection.status === "error" && (
        <p className="setup-error" role="alert">
          {connection.message}
        </p>
      )}
      <button
        className="btn setup-button"
        type="button"
        onClick={checkConnection}
        disabled={connection.status === "checking"}
      >
        {connection.status === "checking" ? "Checking connection..." : "Check sandbox connection"}
      </button>
    </section>
  );
}
