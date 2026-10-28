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

The engine's types are agreed first, so the other folders can be built in parallel.
