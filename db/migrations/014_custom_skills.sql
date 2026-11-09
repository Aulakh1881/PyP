-- 014: the merchant's custom skills (the dashboard's My skills page).
-- A custom skill watches a list (overdue invoices, open disputes…), keeps the
-- ones that pass the merchant's checks, and lets Pyp decide each one with the
-- merchant's playbook, tone and allowed actions. It never acts by itself: every
-- proposal still goes through the checks, dials, undo window and kill switch.
-- spec is engine/custom-skills.ts SkillSpec, validated by the API before saving.
-- next_run_at is when the worker runs it next (null: only when the merchant runs it).
-- last_outcome is what the last run found, for the page. Safe to run more than once.

create table if not exists custom_skills (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null check (length(name) between 1 and 60),
  enabled boolean not null default false,
  spec jsonb not null,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_outcome jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists custom_skills_merchant_idx on custom_skills (merchant_id, created_at);
create index if not exists custom_skills_due_idx on custom_skills (next_run_at) where enabled;

alter table custom_skills enable row level security;
