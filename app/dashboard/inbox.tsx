"use client";

// The Inbox (design §11): a chat box that turns a sentence into cards, and the
// cards themselves. Approve and Dismiss go to /api/cards/{id}/...; "Why?" flips
// a card to its timestamped trace. Looks follow the UI prototype (PR #1).

import { useCallback, useEffect, useState } from "react";

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
    demoData: boolean;
  };
  actions: CardAction[];
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
  const f = card.front;

  async function flip() {
    if (!flipped) setTrace((await api<{ steps: TraceStep[] }>(`/api/cards/${card.id}/trace`)).steps);
    setFlipped(!flipped);
  }

  async function act(action: CardAction) {
    if (action.id !== "approve" && action.id !== "dismiss") return; // answer and undo come later
    setBusy(true);
    try {
      const out = await api<{ message?: string }>(`/api/cards/${card.id}/${action.id}`, { method: "POST" });
      setNote(out.message ?? null);
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
          {f.body && <p className="body">{f.body}</p>}
          {f.reason && <p className="reason">{f.reason}</p>}
          {note && <p className="reply" role="status">{note}</p>}
          <footer className="card-actions">
            {card.actions.map((a) => (
              <button
                key={a.id + a.label}
                className={a.style === "primary" ? "btn" : a.style === "danger" ? "btn btn-danger" : "btn btn-ghost"}
                onClick={() => act(a)}
                disabled={busy || a.id === "answer" || a.id === "undo"}
              >
                {busy && a.id === "approve" ? "Sending…" : a.label}
              </button>
            ))}
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
