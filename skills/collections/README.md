# skills/collections/

**Must · the hero demo** · Detail: `docs/technical-design.md` Appendix B.1

Gets the merchant paid. Triggers: the daily overdue sweep, chat ("Invoice Acme $1,200, net 30"), and `INVOICING.INVOICE.PAID` / `CANCELLED` (stand down).

Creating an invoice from chat: code parses amounts and terms and lists known clients; Claude only picks among them; code computes the due date; an unknown client means `merchant.ask` (the design, Appendix B.1a).

Commands built: `invoice.createAndSend` (never Auto), `invoice.sendReminder`, `invoice.scheduleFollowUp`, `merchant.ask`. Not built yet: `invoice.cancel` (never Auto), `invoice.suggestAutoReminders` (Could).

Code reads the request (`request-parser.ts`) and checks what the model writes (`content-checks.ts`): no amounts that aren't on the invoice, no other invoice numbers, no links of any form.
