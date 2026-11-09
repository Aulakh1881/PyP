-- 012: the merchant's workflows (the dashboard's Workflows page).
-- A workflow is a small diagram: When (a PayPal event or a schedule) → If (checks
-- on facts code computed) → Then (what Pyp should do). It never acts by itself:
-- its Then becomes an instruction to a skill, limited to the commands it names,
-- and every proposal still goes through the checks, dials and kill switch.
-- graph is engine/workflows.ts WorkflowGraph, validated by the API before saving.
-- Safe to run more than once.

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null check (length(name) between 1 and 80),
  enabled boolean not null default false,
  graph jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflows_merchant_idx on workflows (merchant_id, created_at);

alter table workflows enable row level security;
