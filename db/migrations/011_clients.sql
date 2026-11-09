-- 011: the merchant's own client list in Pyp (Clients page, or an email given in chat).
-- PayPal has no contacts list to write to, so this lives here. Collections reads it
-- alongside people from recent PayPal invoices; nicknames ("Pyp", "John") help the
-- chat match a short name. Saving a client never touches PayPal.
-- Safe to run more than once.

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text check (name is null or length(name) between 1 and 120),
  business_name text check (business_name is null or length(business_name) between 1 and 120),
  email text not null check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254),
  nicknames text[] not null default '{}' check (cardinality(nicknames) <= 10),
  source text not null default 'merchant' check (source in ('merchant', 'chat')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists clients_merchant_email_idx on clients (merchant_id, lower(email));

alter table clients enable row level security;
