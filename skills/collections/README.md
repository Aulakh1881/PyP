# skills/collections/

**Must · the hero demo** · Detail: `docs/technical-design.md` Appendix B.1

Gets the merchant paid. Triggers: the daily overdue sweep, chat ("Invoice Acme $1,200, net 30"), and `INVOICING.INVOICE.PAID` / `CANCELLED` (stand down).

Creating an invoice from chat: code parses amounts and terms and lists known clients; Claude only picks among them; code computes the due date; an unknown client means `merchant.ask` (the design, Appendix B.1a).

Commands built: `invoice.createAndSend` (never Auto), `invoice.sendReminder`, `invoice.scheduleFollowUp`, `invoice.cancel` (never Auto), `invoice.suggestAutoReminders` (card only, never Auto), `merchant.ask`. `stand-down.ts` handles paid and cancelled invoices with no model call.

Code reads the request (`request-parser.ts`) and checks what the model writes (`engine/content-checks.ts`, shared with Disputes): no amounts that aren't on the invoice, no other invoice numbers, no links of any form.
