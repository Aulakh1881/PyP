// The model for this server: Ollama or Claude, picked by gateway/index.ts
// from the environment, with the daily cap kept in Postgres.

import type { AgentClient } from "@/engine/types";
import { createAgentClient } from "@/gateway";
import { getPool } from "@/jobs/db";
import { PgLedger } from "@/jobs/spend-ledger";

let agent: AgentClient | null = null;

export function serverAgent(): AgentClient {
  agent ??= createAgentClient(process.env, new PgLedger(getPool()));
  return agent;
}
