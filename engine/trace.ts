// The timestamped steps on the back of each card (design §11.2). The engine
// collects them in memory; owner C persists them as trace_steps rows.

import type { TraceStage, TraceStep } from "./types";

export class Trace {
  readonly steps: TraceStep[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  step(stage: TraceStage, label: string, detail?: Record<string, unknown>): TraceStep {
    const s: TraceStep = { at: this.now().toISOString(), stage, label, ...(detail ? { detail } : {}) };
    this.steps.push(s);
    return s;
  }
}
