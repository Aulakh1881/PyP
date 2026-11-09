"use client";

// The Inbox (design §11): a chat box that turns a sentence into cards, and the
// cards themselves. Approve and Dismiss go to /api/cards/{id}/...; "Why?" flips
// a card to its timestamped trace. Looks follow the UI prototype (PR #1).

import { useCallback, useEffect, useState } from "react";
import { ControlsPanel } from "./controls";

interface CardAction {
  id: "approve" | "dismiss" | "undo" | "answer";
  label: string;
  style: "primary" | "secondary" | "danger";
}

interface Card {
  id: string;
  state: string;
  createdAt: string;
  front: {
    eyebrow: string;
    title: string;
    subtitle?: string;
    body?: string;
    lines?: { description: string; amount: string }[];
    reason?: string;
    scheduledFor?: string;
    options?: string[];
    edit?: { field: string; label: string; value: string }[];
    demoData: boolean;
  };
  actions: CardAction[];
}

/** "Sends in 0:42 unless you tap Undo", ticking each second; days for a follow-up. */
function Countdown({ at, onDue }: { at: string; onDue: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // Give the worker a moment to run it, then keep refreshing until the card moves on.
    if (left !== 0) return;
    const t = setInterval(onDue, 15_000);
    return () => clearInterval(t);
  }, [left, onDue]);
  if (left === 0) return <p className="reason">Running now…</p>;
  if (left >= 3600) {
    const when = left >= 86_400 ? `${Math.round(left / 86_400)} day${left >= 1.5 * 86_400 ? "s" : ""}` : `${Math.round(left / 3600)} h`;
    return <p className="reason">Pyp looks again in {when}. Undo to cancel.</p>;
  }
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, "0");
  return (
    <p className="reason" role="timer">
      Runs in {m}:{s} unless you tap Undo
    </p>
  );
}

interface TraceStep {
  at: string;
  kind: string;
  label: string;
  ok: boolean | null;
}

const STATE_LABEL: Record<string, string> = {
  awaiting_approval: "Needs you",
  scheduled: "Scheduled",
  executing: "Sending…",
  executed: "Done",
  failed: "Failed",
  obsolete: "Not sent",
  rejected: "Dismissed",
  undone: "Undone",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !("status" in body)) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function Inbox() {
  const [cards, setCards] = useState<Card[]>([]);
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCards((await api<{ cards: Card[] }>("/api/cards")).cards);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect -- the first fetch of the feed
  }, [load]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || thinking) return;
    setThinking(true);
    setReply(null);
    setError(null);
    try {
      const out = await api<{ reply: string }>("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
      setReply(out.reply);
      setMessage("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setThinking(false);
    }
  }

  return (
    <div className="inbox">
      <form className="chat" onSubmit={send}>
        <label htmlFor="chat-input">Ask Pyp</label>
        <div className="chat-row">
          <input
            id="chat-input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Invoice Jordan Kim $300 for the logo, net 30"
            maxLength={1000}
            disabled={thinking}
          />
          <button className="btn" type="submit" disabled={thinking || !message.trim()}>
            {thinking ? "Thinking…" : "Send"}
          </button>
        </div>
        {thinking && <p className="hint">Pyp is reading PayPal and deciding. A local model can take a minute or two.</p>}
        {reply && <p className="reply" role="status">{reply}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </form>

      <ControlsPanel onCardsChanged={load} />

      <section aria-label="Cards" className="cards">
        {cards.length === 0 && <p className="hint">No cards yet. Ask Pyp to invoice a client to make one.</p>}
        {cards.map((c) => (
          <CardView key={c.id} card={c} onChanged={load} />
        ))}
      </section>
    </div>
  );
}

function CardView({ card, onChanged }: { card: Card; onChanged: () => Promise<void> }) {
  const [flipped, setFlipped] = useState(false);
  const [trace, setTrace] = useState<TraceStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const f = card.front;
  const canEdit = card.state === "awaiting_approval" && !!f.edit?.length;

  function startEdit() {
    setDraft(Object.fromEntries((f.edit ?? []).map((e) => [e.field, e.value])));
    setEditing(true);
  }

  async function flip() {
    try {
      if (!flipped) setTrace((await api<{ steps: TraceStep[] }>(`/api/cards/${card.id}/trace`)).steps);
      setFlipped(!flipped);
    } catch (err) {
      setNote((err as Error).message);
    }
  }

  async function act(action: CardAction) {
    setBusy(true);
    try {
      let body: string | undefined;
      if (action.id === "answer") body = JSON.stringify({ optionIndex: (f.options ?? []).indexOf(action.label) });
      if (action.id === "approve" && editing) {
        // Only what changed goes to the server; it checks the new words like the model's.
        const edits = Object.fromEntries(Object.entries(draft).filter(([k, v]) => f.edit?.find((e) => e.field === k)?.value !== v));
        if (Object.keys(edits).length) body = JSON.stringify({ edits });
      }
      const out = await api<{ status?: string; message?: string }>(`/api/cards/${card.id}/${action.id}`, { method: "POST", body });
      setNote(out.message ?? null);
      // Refused or paused: nothing was sent, so keep the merchant's words to fix and approve.
      if (out.status !== "edit_rejected" && out.status !== "paused") setEditing(false);
      await onChanged();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card${flipped ? " flipped" : ""}`} aria-busy={busy}>
      <div className="card-inner">
        <div className="card-face card-front" aria-hidden={flipped}>
          <header className="card-top">
            <span className="eyebrow">{f.eyebrow}</span>
            <span className={`state state-${card.state}`}>{STATE_LABEL[card.state] ?? card.state}</span>
            {f.demoData && <span className="demo">DEMO DATA</span>}
          </header>
          <h2>{f.title}</h2>
          {f.subtitle && <p className="muted">{f.subtitle}</p>}
          {f.lines && (
            <ul className="lines">
              {f.lines.map((l, i) => (
                <li key={i}>
                  <span>{l.description}</span>
                  <b>{l.amount}</b>
                </li>
              ))}
            </ul>
          )}
          {editing ? (
            <div className="edit">
              {(f.edit ?? []).map((e) => (
                <label key={e.field}>
                  <span>{e.label}</span>
                  <textarea
                    value={draft[e.field] ?? ""}
                    rows={e.field === "subject" ? 1 : 4}
                    onChange={(ev) => setDraft({ ...draft, [e.field]: ev.target.value })}
                  />
                </label>
              ))}
              <p className="hint">Pyp checks your words like its own before sending: the amounts must match PayPal, and no links.</p>
            </div>
          ) : (
            f.body && <p className="body">{f.body}</p>
          )}
          {f.reason && <p className="reason">{f.reason}</p>}
          {card.state === "scheduled" && f.scheduledFor && <Countdown at={f.scheduledFor} onDue={onChanged} />}
          {note && <p className="reply" role="status">{note}</p>}
          <footer className="card-actions">
            {card.actions.map((a) => (
              <button
                key={a.id + a.label}
                className={a.style === "primary" ? "btn" : a.style === "danger" ? "btn btn-danger" : "btn btn-ghost"}
                onClick={() => act(a)}
                disabled={busy}
              >
                {busy && a.id === "approve" ? "Sending…" : a.id === "approve" && editing ? "Approve with my edits" : a.label}
              </button>
            ))}
            {canEdit && (
              <button className="link" onClick={() => (editing ? setEditing(false) : startEdit())} disabled={busy}>
                {editing ? "Cancel edit" : "Edit"}
              </button>
            )}
            <button className="link" onClick={flip}>
              Why?
            </button>
          </footer>
        </div>

        <div className="card-face card-back" aria-hidden={!flipped}>
          <header className="card-top">
            <span className="eyebrow">THE DECISION TRACE</span>
          </header>
          <ol className="trace">
            {(trace ?? []).map((s, i) => (
              <li key={i}>
                <time dateTime={s.at}>{new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                <span className="kind">{s.kind}</span>
                <span className={s.ok === false ? "bad" : ""}>
                  {s.ok === true ? "✓ " : s.ok === false ? "✗ " : ""}
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
          <footer className="card-actions">
            <button className="link" onClick={flip}>
              Back to the card
            </button>
          </footer>
        </div>
      </div>
    </article>
  );
}
