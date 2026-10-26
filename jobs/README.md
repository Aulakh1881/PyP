# jobs/

**Owner:** C · Detail: `docs/technical-design.md` §9.3

Background work: `runSkill`, `execute`, the daily sweeps (overdue invoices, dispute deadlines), undo timers, nightly reconcile and `compactOldRuns` cleanup. Inngest if it runs cleanly on Render; otherwise a Postgres job table plus Render cron (decided Mon–Tue, master plan §8).
