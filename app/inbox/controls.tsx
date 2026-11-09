"use client";

// The merchant's controls (design §4.3): the kill switch, "check now" for the
// sweeps, the undo window and one dial per action. What a dial may be is checked
// on the server (jobs/controls.ts); this only shows what the server allows.

import { useCallback, useEffect, useState } from "react";

type Dial = "off" | "ask" | "auto";

interface Controls {
  killSwitch: boolean;
  undoSeconds: number;
  commands: { id: string; skill: string; label: string; dial: Dial; canAuto: boolean }[];
}

const DIAL_LABEL: Record<Dial, string> = { off: "Off", ask: "Ask me", auto: "Auto" };
const SKILL_LABEL: Record<string, string> = { collections: "Getting paid", disputes: "Disputes", insights: "Insights" };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? body.message ?? `Request failed (${res.status})`);
  return body as T;
}

export function ControlsPanel({ onCardsChanged }: { onCardsChanged: () => Promise<void> }) {
  const [c, setC] = useState<Controls | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [undo, setUndo] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await call<Controls>("/api/rules");
      setC(next);
      setUndo(String(next.undoSeconds));
    } catch (err) {
      setNote((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect -- the first fetch of the controls
  }, [load]);

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setNote(null);
    try {
      const msg = await fn();
      if (msg) setNote(msg);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const toggleKill = () =>
    run("kill", async () => {
      const next = await call<Controls>("/api/kill-switch", { method: "POST", body: JSON.stringify({ on: !c!.killSwitch }) });
      setC(next);
      return next.killSwitch ? "Pyp is paused. Nothing will be sent until you resume." : "Pyp is running again.";
    });

  const setDial = (id: string, dial: Dial) =>
    run(id, async () => {
      setC(await call<Controls>("/api/rules", { method: "PUT", body: JSON.stringify({ dials: { [id]: dial } }) }));
    });

  const saveUndo = () =>
    run("undo", async () => {
      // Number("") is 0: an emptied field must not turn the undo window off.
      if (!/^\d+$/.test(undo.trim()) || Number(undo) > 600) return "Type a number of seconds from 0 to 600.";
      const next = await call<Controls>("/api/rules", { method: "PUT", body: JSON.stringify({ undoSeconds: Number(undo) }) });
      setC(next);
      return `Auto actions now wait ${next.undoSeconds} s before sending.`;
    });

  const sweep = (name: string, label: string) =>
    run(name, async () => {
      const out = await call<{ found: number; skipped: number; deferred?: number; ran: number; cardIds: string[]; failed: string[] }>(`/api/sweeps/${name}`, {
        method: "POST",
      });
      await onCardsChanged();
      const parts = [`${label}: found ${out.found}`, `${out.cardIds.length} new card${out.cardIds.length === 1 ? "" : "s"}`];
      if (out.skipped) parts.push(`${out.skipped} already in hand`);
      if (out.deferred) parts.push(`${out.deferred} left for next time`);
      if (out.failed.length) parts.push(`${out.failed.length} couldn't be checked`);
      return parts.join(" · ");
    });

  if (!c) return note ? <p className="auth-error" role="alert">{note}</p> : null;

  const skills = [...new Set(c.commands.map((x) => x.skill))];
  return (
    <section className={`controls${c.killSwitch ? " paused" : ""}`} aria-label="Pyp's controls">
      <div className="controls-top">
        <div>
          <strong>{c.killSwitch ? "Pyp is paused" : "Pyp is running"}</strong>
          <p className="hint">{c.killSwitch ? "Nothing goes to PayPal until you resume." : "Every action follows your rules below."}</p>
        </div>
        <button className={c.killSwitch ? "btn" : "btn btn-danger"} onClick={toggleKill} disabled={busy !== null} aria-pressed={c.killSwitch}>
          {busy === "kill" ? "…" : c.killSwitch ? "Resume Pyp" : "Pause Pyp"}
        </button>
      </div>

      <div className="controls-row">
        <button className="btn btn-ghost" onClick={() => sweep("overdue-invoices", "Overdue invoices")} disabled={busy !== null || c.killSwitch}>
          {busy === "overdue-invoices" ? "Checking…" : "Check overdue invoices now"}
        </button>
        <button className="btn btn-ghost" onClick={() => sweep("dispute-deadlines", "Dispute deadlines")} disabled={busy !== null || c.killSwitch}>
          {busy === "dispute-deadlines" ? "Checking…" : "Check dispute deadlines now"}
        </button>
        <button className="btn btn-ghost" onClick={() => sweep("weekly-brief", "Weekly brief")} disabled={busy !== null || c.killSwitch}>
          {busy === "weekly-brief" ? "Writing…" : "Weekly brief now"}
        </button>
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide rules" : "Rules"}
        </button>
      </div>

      {note && (
        <p className="reply" role="status">
          {note}
        </p>
      )}

      {open && (
        <div className="rules">
          <label className="undo-row">
            <span>Undo window for Auto actions</span>
            <input type="number" min={0} max={600} value={undo} onChange={(e) => setUndo(e.target.value)} aria-describedby="undo-hint" />
            <span>s</span>
            <button className="btn btn-ghost" onClick={saveUndo} disabled={busy !== null || undo === String(c.undoSeconds)}>
              Save
            </button>
          </label>
          <p id="undo-hint" className="hint">
            0 to 600 seconds. Auto actions wait this long, with an Undo button, before anything is sent.
          </p>
          {skills.map((s) => (
            <fieldset key={s} className="dials">
              <legend>{SKILL_LABEL[s] ?? s}</legend>
              {c.commands
                .filter((x) => x.skill === s)
                .map((x) => (
                  <div key={x.id} className="dial-row">
                    <span id={`dial-${x.id}`}>{x.label}</span>
                    <div className="segmented" role="radiogroup" aria-labelledby={`dial-${x.id}`}>
                      {(["off", "ask", "auto"] as Dial[]).map((d) => (
                        <button
                          key={d}
                          role="radio"
                          aria-checked={x.dial === d}
                          className={x.dial === d ? "on" : ""}
                          disabled={busy !== null || (d === "auto" && !x.canAuto)}
                          title={d === "auto" && !x.canAuto ? "This always needs your approval" : undefined}
                          onClick={() => x.dial !== d && setDial(x.id, d)}
                        >
                          {DIAL_LABEL[d]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}
