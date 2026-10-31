# executor/

**Owner:** C · Detail: `docs/technical-design.md` §0.11 and §9.4

**The only place that writes to PayPal.** For each approved or scheduled proposal it re-fetches live state, calls PayPal with `PayPal-Request-Id = proposal id`, or `<proposal id>:<step>` for a command that writes twice (so a retry can never act twice), maps the result, and writes the execution row, trace step and activity-log entry. Auto actions run only after the 60-second undo window.

**The engine contract** (what runs hand over, proposal ids, `resolved`, re-checking before a write): [`engine/README.md`](../engine/README.md#the-contract-for-owners-a-and-c).
