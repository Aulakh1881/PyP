-- 013: what Pyp knows about the merchant's business (the dashboard's "Pyp's memory").
-- Facts the merchant added, or that Pyp picked up in chat. A fact Pyp only noticed
-- waits as 'proposed' until the merchant confirms it; "remember that…" is active at once.
-- Active facts go into case files as merchant notes: for Pyp's judgment, never quoted
-- to clients, and never above code's checks. A fact can be about the whole business,
-- one client (by email), or one invoice or dispute (subject_ref).
-- Safe to run more than once.

create table if not exists merchant_facts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  text text not null check (length(text) between 1 and 300),
  client_email text check (client_email is null or length(client_email) <= 254),
  subject_ref text check (subject_ref is null or length(subject_ref) <= 200),
  status text not null default 'active' check (status in ('active', 'proposed')),
  source text not null default 'merchant' check (source in ('merchant', 'chat')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merchant_facts_merchant_idx on merchant_facts (merchant_id, status);

alter table merchant_facts enable row level security;
