-- 017: files the merchant gives Pyp (jobs/documents.ts, engine/document-reader.ts).
-- A receipt, a quote or contract, shipping proof or a delivery photo: an image
-- or a PDF up to 8 MB. Pyp reads it once (facts), and never takes instructions
-- from it. On a dispute or an invoice (subject_ref), what it shows becomes a
-- note in that case file, which the evidence can cite (merchant_facts with
-- source 'document'). Deleting a file deletes its notes.
-- Safe to run more than once.

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null check (length(name) between 1 and 200),
  media_type text not null check (media_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  sha256 text not null,
  data bytea not null,
  subject_ref text check (subject_ref is null or length(subject_ref) <= 200),
  -- read: facts are in; suspicious: read, but it tries to instruct Pyp, so nothing uses it; failed: why is in reason.
  status text not null check (status in ('read', 'suspicious', 'failed')),
  facts jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists documents_merchant_idx on documents (merchant_id, created_at desc);
create index if not exists documents_subject_idx on documents (merchant_id, subject_ref);

alter table merchant_facts drop constraint if exists merchant_facts_source_check;
alter table merchant_facts add constraint merchant_facts_source_check check (source in ('merchant', 'chat', 'document'));
alter table merchant_facts add column if not exists document_id uuid references documents(id) on delete cascade;

alter table documents enable row level security;
