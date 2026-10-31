# Pyp: notes for coding agents

- **Source of truth:** `docs/master-plan.md`, then `docs/technical-design.md`, then `docs/TODO.md`.
- **Nothing writes to PayPal except `executor/`.** Lint and `evals/boundary.test.ts` enforce it.
- **Code does the maths.** The model never calculates money; it picks among ids code gives it.
- **No secrets in Git.** Keys live in `.env.local` (git-ignored); `.env.example` has names only.
- **Code lands through pull requests**, never pushed straight to `main`. Run `npm run check` first.
- **The engine contract** for other folders is in `engine/README.md`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
