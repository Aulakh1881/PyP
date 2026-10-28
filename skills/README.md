# skills/

**Owner:** B · Detail: `docs/technical-design.md` §0.4, §7.2 and Appendix B

One folder per skill. A skill is **our playbook and rules on top of PayPal's read tools** (from PayPal's MCP server). Each folder holds:

| File | What it holds |
|---|---|
| `skill.ts` | Id, triggers (events, sweeps, chat), model tier |
| `case-file.ts` | Gathers the facts for one decision and writes the case file |
| `commands/*.ts` | One file per action on the menu: params schema, description, check, PayPal write |
| `prompt.ts` | The playbook in plain English (the cached part of the prompt; a template so it can name the merchant) |
| `policy.ts` | Default dial settings and limits; never-Auto actions |
| `evals/` | Test cases: fixed case file in, expected decision out (`*.test.ts`, run by `npm test` with the scripted model) |

Adding a skill = a new folder + one line in `engine/registry.ts`. Parked skills (Refunds and others) are listed in the master plan §4.
