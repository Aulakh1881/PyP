# skills/collections/

**Must · the hero demo** · Detail: `docs/technical-design.md` Appendix B.1

Gets the merchant paid. Triggers: the daily overdue sweep, chat ("Invoice Acme $1,200, net 30"), and `INVOICING.INVOICE.PAID` / `CANCELLED` (stand down).

Commands: `invoice.createAndSend`, `invoice.sendReminder`, `invoice.scheduleFollowUp`, `invoice.suggestAutoReminders`, `invoice.cancel` (never Auto), `merchant.ask`.
