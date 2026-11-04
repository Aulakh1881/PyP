-- Merchant holds ("client replied, hold off") and what webhook processing
-- needs. Holds stop reminders in code (engine EngineDb.activeHold), so the
-- model doesn't have to notice a note.

create table holds (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  subject_ref text not null,           -- e.g. "invoice:INV2-ACME-0042"
  reason text not null check (length(reason) between 1 and 500),
  until date,                          -- merchant-local; null = until lifted
  set_by text not null default 'merchant',
  set_at timestamptz not null default now(),
  lifted_at timestamptz
);

create index holds_active_idx on holds (merchant_id, subject_ref) where lifted_at is null;

-- One run per event: a duplicate delivery is a no-op (design §9.2 step 3).
alter table runs add constraint runs_trigger_event_unique unique (trigger_event_id);

alter table events
  add column processed_at timestamptz,
  add column outcome text;

alter table holds enable row level security;
