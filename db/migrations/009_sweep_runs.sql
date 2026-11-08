-- Sweeps (design §9.3): one row per merchant, sweep and merchant-local day.
-- The worker inserts the row before it sweeps, so a sweep runs at most once a
-- day even with two workers or a restart. "Run now" from the dashboard skips it.

create table sweep_runs (
  merchant_id uuid not null references merchants(id),
  name text not null,
  local_date date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text,
  primary key (merchant_id, name, local_date)
);

alter table sweep_runs enable row level security;
