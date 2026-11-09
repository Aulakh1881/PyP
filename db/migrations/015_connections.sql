-- 015: Connections (Setup → Connections, jobs/connections.ts).
--
-- Outbound: when a card needs the merchant, Pyp posts it to their Slack or
-- Discord channel, or sends signed JSON to any app (n8n, Zapier, Make…). Each
-- message links to the card in Pyp; approving always stays in Pyp.
-- Inbound (Slack only): /pyp talks to Pyp like the chat does (it can only make
-- cards) or runs a custom skill. A workspace is linked with a one-time code
-- (/pyp connect CODE), and only the person who linked it can use /pyp.
--
-- url and secret are secrets: the API never sends them back whole.
-- Safe to run more than once.

create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  kind text not null check (kind in ('slack', 'discord', 'webhook')),
  url text not null check (url like 'https://%'),
  -- Webhook only: the key Pyp signs each request with (HMAC-SHA256), so the app can check it came from Pyp.
  secret text,
  enabled boolean not null default true,
  -- What the last post said, for the Connections list ("sent 2 min ago" / the error).
  last_status text,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, kind)
);

-- One row per card per connection: inserting it claims the post, so with
-- several workers each card goes to each connection once.
create table if not exists connection_posts (
  connection_id uuid not null references connections(id) on delete cascade,
  card_id uuid not null references cards(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (connection_id, card_id)
);

-- /pyp in Slack: which workspace and person belong to which merchant.
create table if not exists slack_links (
  merchant_id uuid primary key references merchants(id),
  team_id text unique,
  team_name text,
  slack_user_id text,
  slack_user_name text,
  connect_code text unique,
  connect_code_expires_at timestamptz,
  linked_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table connections enable row level security;
alter table connection_posts enable row level security;
alter table slack_links enable row level security;
