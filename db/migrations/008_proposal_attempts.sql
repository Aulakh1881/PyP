-- How many times the worker has picked up a scheduled proposal (jobs/due-run.ts).
-- A retryable failure puts it back with a backoff; after a few tries it comes to
-- the merchant instead of retrying forever (design §9.4 step 3).

alter table proposals add column attempts integer not null default 0;

-- The worker's queue: scheduled proposals by due time.
create index proposals_due_idx on proposals (scheduled_for) where status = 'scheduled';
