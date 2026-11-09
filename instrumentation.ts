// Starts Pyp's worker loop inside the web server (design ADR-008: the working
// default, so it needs a paid instance that doesn't sleep). Every few seconds
// it runs Auto actions whose undo window has passed and follow-ups that have
// come due (jobs/due-run.ts), and once a day from 08:00 merchant-local the
// overdue and dispute-deadline sweeps (jobs/sweep-run.ts), and the merchant's
// custom skills when their schedule comes round (jobs/custom-skills.ts), and new
// cards go to the merchant's Slack, Discord or other app (jobs/connections.ts).
//
//   PYP_WORKER=off              don't start it (tests, a second instance)
//   PYP_WORKER_INTERVAL_S=15    seconds between ticks (default 15)

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.PYP_WORKER === "off" || !process.env.DATABASE_URL) return;
  // `next build` loads this file in its workers too; they must never claim work.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Dev reloads can call register again; keep one loop per process.
  const g = globalThis as { pypWorker?: NodeJS.Timeout };
  if (g.pypWorker) return;

  const { runDueWorkFromEnv } = await import("./executor/from-env");
  const { runDailySweepsFromEnv, runDueSkillsFromEnv } = await import("./lib/sweeps");
  const { postNewCardsFromEnv } = await import("./lib/connections");
  const seconds = Math.max(5, Number(process.env.PYP_WORKER_INTERVAL_S ?? "15") || 15);
  let busy = false;
  g.pypWorker = setInterval(async () => {
    if (busy) return; // a slow tick (a model call) never overlaps the next
    busy = true;
    try {
      for (const r of await runDueWorkFromEnv()) console.log(`[pyp worker] ${r.commandId} ${r.status}: ${r.message}`);
      for (const s of await runDailySweepsFromEnv()) console.log(`[pyp worker] sweep ${s.name}: ${JSON.stringify(s.outcome)}`);
      for (const s of await runDueSkillsFromEnv()) console.log(`[pyp worker] skill ${s.name}: ${JSON.stringify(s.outcome)}`);
      for (const p of await postNewCardsFromEnv()) console.log(`[pyp worker] ${p.kind} card ${p.cardId}: ${p.status}`);
    } catch (err) {
      console.error(`[pyp worker] tick failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, seconds * 1000);
  g.pypWorker.unref?.();
}
