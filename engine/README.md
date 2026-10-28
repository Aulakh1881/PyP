# engine/

**Owner:** B · Detail: `docs/technical-design.md` §7 and §8

The heart of Pyp, plain TypeScript:

- `registry.ts`: the list of skills (one line per skill)
- `run-skill.ts`: gather → decide → check → act
- `schema-builder.ts`: command definitions → the JSON schema Claude must answer in
- `prompt-builder.ts`: cached system prompt + per-case turn prompt
- `validator.ts`: re-checks each proposal against fresh PayPal data
- `policy.ts`: the dial (Off / Ask me / Auto), limits, never-Auto list, kill switch
- `trace.ts`: the timestamped steps on the back of each card
- `types.ts`: the shared contracts (SkillDef, CommandDef, CaseFile, AgentClient, the PayPal reads and database calls the engine needs). **Change these deliberately and tell the team.**
- `format.ts` and `xml.ts`: money and date helpers (integer cents, never floats), and XML building with escaping
- `commands/merchant-ask.ts`: the question card every skill offers

The engine's types are agreed first, so the other folders can be built in parallel.

**What other folders implement for the engine:** `PayPalReads` and `EngineDb` in `types.ts` (owner C: MCP/REST reads and Postgres), and the storage of a `RunResult` from `runSkill()` as runs, proposals, cards and trace rows. Tests use fakes (`skills/collections/evals/fixtures.ts`).
