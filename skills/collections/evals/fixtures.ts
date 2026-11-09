// DEMO DATA for Collections tests: Maya Ortiz Design and Acme Studio's
// invoice 0042 (design §7.3). Fake PayPal reads and a fake database.

import type { Client, EngineDb, Hold, Invoice, Merchant, MerchantRules, PayPalReads, SkillContext } from "@/engine/types";

export const NOW = new Date("2026-10-28T15:00:00Z"); // 08:00 in Los Angeles

export const merchant: Merchant = {
  id: "m_demo",
  name: "Maya Ortiz Design",
  currency: "USD",
  timezone: "America/Los_Angeles",
  toneGuide: "Warm and brief. First names. No exclamation marks in firm or final reminders.",
};

export const acmeInvoice: Invoice = {
  id: "INV2-ACME-0042",
  number: "0042",
  status: "UNPAID",
  currency: "USD",
  total: "1200.00",
  amountDue: "1200.00",
  dueDate: "2026-10-21",
  recipientName: "Sam Lee",
  recipientEmail: "sam@acme.example",
};

export const demoClients: Client[] = [
  { id: "cl_1", name: "Sam Lee", businessName: "Acme Studio", email: "sam@acme.example" },
  { id: "cl_2", name: "Priya Shah", businessName: "Beta LLC", email: "priya@beta.example" },
  { id: "cl_3", name: "Jordan Kim", businessName: null, email: "jordan.kim@example.com" },
];

export function rules(overrides: Partial<MerchantRules> = {}): MerchantRules {
  return { killSwitch: false, undoSeconds: 60, commands: {}, ...overrides };
}

export interface FakeWorld {
  invoices: Record<string, Invoice>;
  /** What check() sees if PayPal changed after the case file was built. */
  freshInvoices?: Record<string, Invoice>;
  reminders?: Record<string, { count: number; lastSentAt: string | null }>;
  remindCallsToday?: number;
  notes?: string[];
  clients?: Client[];
  /** Clients the merchant saved in Pyp (EngineDb.savedClients). */
  savedClients?: Client[];
  /** Earlier invoices by recipient email. Unset = the read isn't available. */
  clientInvoices?: Record<string, Invoice[]>;
  /** Unset = the hold read isn't available; null = no hold. */
  hold?: Hold | null;
  /** What check() sees for the hold, if it changed after the case file was built. */
  freshHold?: Hold | null;
}

export function context(world: FakeWorld, r: MerchantRules = rules()): SkillContext {
  let reads = 0;
  const read: PayPalReads = {
    // The first read builds the case file; later reads are the validator's fresh ones.
    async getInvoice(id) {
      reads++;
      const fresh = reads > 1 ? world.freshInvoices?.[id] : undefined;
      return fresh ?? world.invoices[id] ?? null;
    },
    async recentClients() {
      return world.clients ?? demoClients;
    },
    ...(world.clientInvoices
      ? { clientInvoices: async (email: string, limit: number) => (world.clientInvoices![email] ?? []).slice(0, limit) }
      : {}),
  };
  let holdReads = 0;
  const db: EngineDb = {
    async remindersSent(id) {
      return world.reminders?.[id] ?? { count: 0, lastSentAt: null };
    },
    async remindCallsToday() {
      return world.remindCallsToday ?? 0;
    },
    async merchantNotes() {
      return world.notes ?? [];
    },
    ...(world.savedClients ? { savedClients: async () => world.savedClients! } : {}),
    ...(world.hold !== undefined
      ? {
          activeHold: async () => {
            holdReads++;
            return holdReads > 1 && world.freshHold !== undefined ? world.freshHold : world.hold!;
          },
        }
      : {}),
  };
  return { merchant, rules: r, read, db, now: () => NOW };
}

/** A well-formed first reminder for invoice 0042. */
export function friendlyReminder(over: Partial<{ tone: string; note: string; invoiceId: string }> = {}) {
  return {
    title: "Acme is 7 days late",
    summary: "First reminder for invoice 0042. A friendly nudge fits.",
    actions: [
      {
        command: "invoice.sendReminder",
        params: {
          invoiceId: over.invoiceId ?? acmeInvoice.id,
          tone: over.tone ?? "friendly",
          subject: "Quick reminder: invoice 0042",
          note: over.note ?? "Hi Sam, a friendly nudge on invoice 0042 for $1,200.00, due Oct 21. Thanks so much. Maya Ortiz Design",
        },
        why: "INV2-ACME-0042 is 7 days overdue with no reminders sent.",
      },
    ],
    confidence: "high",
    questionForMerchant: null,
  };
}

/** A paid earlier invoice to Acme, for client history. */
export function pastAcmeInvoice(n: number, dueDate: string, paidDate: string): Invoice {
  return {
    ...acmeInvoice,
    id: `INV2-ACME-00${30 + n}`,
    number: `00${30 + n}`,
    status: "PAID",
    amountDue: "0.00",
    dueDate,
    paidDate,
  };
}
