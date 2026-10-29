-- Pyp Week 1 database core.
-- Later feature tables (client_profiles, preferences, spend_ledger and
-- paypal_connections) should be added in feature-specific migrations.

create extension if not exists pgcrypto;

create table merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Los_Angeles',
  currency char(3) not null default 'USD',
  kill_switch boolean not null default false,
  extension_token_hash text,
  undo_window_s integer not null default 60
    check (undo_window_s between 0 and 600),
  created_at timestamptz not null default now()
);

create table rules (
  merchant_id uuid not null references merchants(id),
  command_id text not null,
  dial text not null check (dial in ('off', 'ask', 'auto')),
  limits_json jsonb not null default '{}'::jsonb,
  primary key (merchant_id, command_id)
);

create table events (
  id text primary key,
  merchant_id uuid not null references merchants(id),
  type text not null,
  resource_id text,
  raw_json jsonb,
  status text not null default 'queued',
  received_at timestamptz not null default now()
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  skill text not null,
  subject_ref text not null,
  trigger_event_id text references events(id),
  model text,
  case_file_xml text,
  output_json jsonb,
  usage_json jsonb,
  cost_usd numeric(10, 5),
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  merchant_id uuid not null references merchants(id),
  command_id text not null,
  params_json jsonb not null,
  why text,
  decision text check (decision in ('auto', 'ask', 'block')),
  policy_rule text,
  status text not null,
  valid_until timestamptz,
  scheduled_for timestamptz,
  decided_by text,
  decided_at timestamptz,
  edit_diff jsonb,
  created_at timestamptz not null default now()
);

create table executions (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id),
  paypal_request_id text not null,
  http_status integer,
  paypal_debug_id text,
  response_json jsonb,
  attempt integer not null check (attempt > 0),
  at timestamptz not null default now()
);

create table trace_steps (
  id bigserial primary key,
  run_id uuid not null references runs(id),
  proposal_id uuid references proposals(id),
  at timestamptz not null default clock_timestamp(),
  kind text not null,
  label text not null,
  ok boolean,
  detail_json jsonb
);

create table cards (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  run_id uuid not null references runs(id),
  proposal_id uuid references proposals(id),
  skill text not null,
  state text not null,
  front_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table activity_log (
  id bigserial primary key,
  merchant_id uuid not null references merchants(id),
  actor text not null
    check (actor ~ '^(pyp|merchant|rule|mcp:[a-z0-9_-]+)$'),
  summary text not null,
  refs_json jsonb,
  at timestamptz not null default now()
);

create index proposals_merchant_status_idx
  on proposals (merchant_id, status);

create index trace_steps_run_at_idx
  on trace_steps (run_id, at);

create index cards_merchant_state_created_idx
  on cards (merchant_id, state, created_at desc);
