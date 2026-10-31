// The daily spend cap (design §7.7). Reserve a high estimate before each call,
// settle with real usage after, and fail closed: if the cap would be exceeded
// or the ledger can't be reached, no model call happens.

import type { AgentClient, CompletionRequest, GatewayEvent } from "@/engine/types";
import { CLAUDE_MODELS, estimateUsd } from "./models";

export interface SpendLedger {
  /** Reserve `usd` against today's cap; throws BudgetExceeded if it doesn't fit. Returns a reservation id. */
  reserve(usd: number, capUsd: number, purpose: string): Promise<string>;
  /** Replace a reservation with what the call really cost (0 if it failed before any usage). */
  settle(reservationId: string, actualUsd: number): Promise<void>;
}

export class BudgetExceeded extends Error {
  constructor(capUsd: number) {
    super(`Daily model budget of $${capUsd.toFixed(2)} reached; Pyp will try again tomorrow`);
  }
}

/**
 * In-memory ledger for development and tests; one process only. Owner C swaps
 * in one backed by runs.cost_usd, whose reserve() must check the cap and add
 * the reservation in one atomic step (e.g. a conditional UPDATE), since
 * several workers share it.
 */
export class MemoryLedger implements SpendLedger {
  private day = "";
  private spent = 0;
  private open = new Map<string, { usd: number; day: string }>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async reserve(usd: number, capUsd: number): Promise<string> {
    this.rollOver();
    if (this.spent + usd > capUsd) throw new BudgetExceeded(capUsd);
    this.spent += usd;
    const id = `r${++this.seq}`;
    this.open.set(id, { usd, day: this.day });
    return id;
  }

  async settle(id: string, actualUsd: number): Promise<void> {
    const reserved = this.open.get(id);
    if (reserved === undefined) return;
    this.open.delete(id);
    this.rollOver();
    // A call reserved yesterday counted against yesterday's cap; it can't lower today's.
    if (reserved.day === this.day) this.spent += actualUsd - reserved.usd;
  }

  get spentToday(): number {
    this.rollOver();
    return this.spent;
  }

  private rollOver() {
    const today = this.now().toISOString().slice(0, 10); // UTC day
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }
}

/** Wrap any client so every call goes through the ledger first. */
export function withBudget(
  inner: AgentClient,
  ledger: SpendLedger,
  capUsd: number,
  modelForTier: (tier: CompletionRequest["tier"]) => string = (t) => CLAUDE_MODELS[t],
): AgentClient {
  return {
    name: `${inner.name}+budget`,
    async *complete(req: CompletionRequest): AsyncIterable<GatewayEvent> {
      const estimate = estimateUsd(modelForTier(req.tier), req.system.length + req.turn.length, req.maxOutputTokens);
      const reservation = await ledger.reserve(estimate, capUsd, req.purpose); // throws = fail closed
      let actual: number | null = null;
      try {
        for await (const ev of inner.complete(req)) {
          if (ev.type === "done") actual = ev.usage.costUsd;
          yield ev;
        }
      } finally {
        // A failed call keeps its estimate reserved: we can't know what it cost.
        await ledger.settle(reservation, actual ?? estimate);
      }
    },
  };
}
