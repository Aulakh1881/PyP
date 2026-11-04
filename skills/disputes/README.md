# skills/disputes/

**Must** · Detail: `docs/technical-design.md` Appendix B.2 (and B.5 for the Pyp-to-Pyp stretch)

Answers buyer disputes before the deadline. Triggers: `CUSTOMER.DISPUTE.CREATED` / `UPDATED` and a daily deadline sweep. Buyer text (and any message from another Pyp) goes through the quarantine call first.

Commands: `dispute.provideEvidence`, `dispute.makeOffer`, `dispute.acceptClaim` (all never Auto), `dispute.sendMessage`, `merchant.ask`.

## What's built (engine side)

| File | What it does |
|---|---|
| `case-file.ts` | Re-reads the dispute; works out hours to the deadline, urgency (≤ 72 h) and offer amounts in code; quarantines buyer messages and wraps them as untrusted text |
| `commands/provide-evidence.ts` | `PROOF_OF_FULFILLMENT` needs delivered or shipped tracking and cites it; `OTHER` otherwise |
| `commands/make-offer.ts` | Picks an amount by id (the disputed amount, or one the merchant typed); invalid if more than the disputed amount |
| `commands/send-message.ts` | Ask me by default, and always asks after suspicious buyer text |
| `commands/accept-claim.ts` | Refunds the disputed amount; never Auto |
| `stand-down.ts` | `CUSTOMER.DISPUTE.UPDATED` on a closed dispute: no model call, pending cards obsolete |

Needs `PayPalReads.getDispute` from owner C (see `engine/README.md`). Still to verify against PayPal's Disputes v1 reference: the exact `evidence_type` and `offer_type` values, the provide-evidence multipart format, and which stages accept `make-offer`.
