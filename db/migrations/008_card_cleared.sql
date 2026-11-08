-- 008: "Remove from Inbox" for finished cards.
-- cleared_at is when the merchant removed a finished card (done, dismissed, failed,
-- canceled) from their Inbox. It only hides the card there: the card, its proposal,
-- executions and activity log all stay, so Activity and the audit trail are unchanged.
-- Safe to run more than once.

alter table cards add column if not exists cleared_at timestamptz;
