-- What the engine hands over (engine/README.md, "The contract for owners A
-- and C"), the spend ledger, and Row Level Security on every table.
--
-- The server reads and writes these tables over DATABASE_URL as the table
-- owner, which bypasses RLS. Browsers only ever hold the publishable key, so
-- a table without RLS would be open to anyone with that key. With RLS on and
-- no policy, they see nothing.

alter table merchants add column tone_guide text;

alter table runs
  add column trigger text,
  add column failure text,
  -- The case file's facts and ids, so the executor can re-run check() before
  -- writing (design §9.4) against what the merchant approved.
  add column case_file_json jsonb;

alter table proposals
  -- The exact values the card shows and the executor sends.
  add column resolved_json jsonb,
  add column check_reason text;

-- invoice.createAndSend writes twice (create the draft, then send it).
alter table executions add column step text not null default 'single';

create index executions_proposal_step_idx on executions (proposal_id, step);
create index runs_merchant_started_idx on runs (merchant_id, started_at desc);

-- The daily model budget (gateway/budget.ts). reserve() is one conditional
-- update, so two workers can't both squeeze under the cap.
create table spend_ledger (
  day date primary key,
  spent_usd numeric(12, 6) not null default 0
);

create table spend_reservations (
  id uuid primary key default gen_random_uuid(),
  day date not null references spend_ledger(day),
  reserved_usd numeric(12, 6) not null,
  purpose text,
  settled_usd numeric(12, 6),
  created_at timestamptz not null default now()
);

alter table rules enable row level security;
alter table events enable row level security;
alter table runs enable row level security;
alter table proposals enable row level security;
alter table executions enable row level security;
alter table trace_steps enable row level security;
alter table cards enable row level security;
alter table activity_log enable row level security;
alter table spend_ledger enable row level security;
alter table spend_reservations enable row level security;
