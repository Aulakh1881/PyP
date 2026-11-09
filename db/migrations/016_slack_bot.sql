-- 016: Pyp as a Slack bot (jobs/slack-bot.ts), on top of 015's Slack link.
--
-- Cards that need the merchant arrive as a DM from Pyp with buttons. Low-risk
-- ones (a reminder, a follow-up, a question) can be approved, answered, dismissed
-- or undone right there; anything that moves money or answers a dispute only
-- offers "Review in Pyp". Every button goes through the same approve path as
-- the dashboard (fresh checks, policy, kill switch). The message updates when
-- the card is decided, wherever that happened.
-- The merchant can also DM Pyp or @mention it; follow-ups in a thread work like
-- the chat page.
-- Safe to run more than once.

alter table slack_links add column if not exists dm_channel text;

-- Connections (015): post only cards made since the connection was added or
-- switched back on (no backlog flood), and pause one that keeps failing.
alter table connections add column if not exists post_from timestamptz not null default now();
alter table connections add column if not exists failures integer not null default 0;

-- One row per card sent as a DM: inserting it claims the card (several workers
-- post it once); posted_state is what the message shows, so it's updated when
-- the card moves on.
create table if not exists slack_messages (
  card_id uuid primary key references cards(id) on delete cascade,
  merchant_id uuid not null references merchants(id),
  channel text,
  ts text,
  posted_state text,
  updated_at timestamptz not null default now()
);
create index if not exists slack_messages_merchant_idx on slack_messages (merchant_id, updated_at);

-- A conversation with Pyp in Slack: the last lines of a thread, so a follow-up
-- ("actually make it $500") is read with what came before. Kept per merchant, so
-- a workspace linked to someone else later never sees it.
create table if not exists slack_threads (
  merchant_id uuid not null references merchants(id) on delete cascade,
  team_id text not null,
  channel text not null,
  thread_ts text not null,
  history jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (merchant_id, team_id, channel, thread_ts)
);

-- Slack resends an event it thinks we missed; each is handled once.
create table if not exists slack_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

alter table slack_messages enable row level security;
alter table slack_threads enable row level security;
alter table slack_events enable row level security;
