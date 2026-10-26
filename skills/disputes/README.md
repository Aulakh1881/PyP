# skills/disputes/

**Must** · Detail: `docs/technical-design.md` Appendix B.2 (and B.5 for the Pyp-to-Pyp stretch)

Answers buyer disputes before the deadline. Triggers: `CUSTOMER.DISPUTE.CREATED` / `UPDATED` and a daily deadline sweep. Buyer text (and any message from another Pyp) goes through the quarantine call first.

Commands: `dispute.provideEvidence`, `dispute.makeOffer`, `dispute.acceptClaim` (all never Auto), `dispute.sendMessage`, `merchant.ask`.
