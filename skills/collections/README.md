# skills/collections/

**Must · the hero demo** · Detail: `docs/technical-design.md` Appendix B.1

Gets the merchant paid. Triggers: the daily overdue sweep, chat ("Invoice Acme $1,200, net 30"), and `INVOICING.INVOICE.PAID` / `CANCELLED` (stand down).

Creating an invoice from chat: code parses amounts and terms and lists known clients; Claude only picks among them; code computes the due date; an unknown client means `merchant.ask` (the design, Appendix B.1a).

Commands: `invoice.createAndSend`, `invoice.sendReminder`, `invoice.scheduleFollowUp`, `invoice.suggestAutoReminders`, `invoice.cancel` (never Auto), `merchant.ask`.
