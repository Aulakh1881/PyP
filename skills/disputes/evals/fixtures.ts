// DEMO DATA for Disputes tests: a "not received" dispute on Maya Ortiz
// Design's $600 order, with delivered tracking. Fake PayPal reads and database.

import type { Dispute, EngineDb, MerchantRules, PayPalReads, SkillContext } from "@/engine/types";
import { merchant, NOW, rules } from "@/skills/collections/evals/fixtures";

export { merchant, NOW, rules };

export const notReceived: Dispute = {
  id: "PP-D-123",
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  stage: "INQUIRY",
  currency: "USD",
  amount: "600.00",
  sellerResponseDueDate: "2026-11-06T15:00:00Z", // 216 h (9 days) after NOW
  createdAt: "2026-10-27T10:00:00Z",
  transactionId: "TX-55",
  buyerName: "Alex Rivera",
  items: [{ name: "Brand identity kit (print)", quantity: 1 }],
  messages: [{ postedBy: "BUYER", at: "2026-10-27T10:00:00Z", text: "My package never arrived. I want a refund." }],
  tracking: [{ carrier: "USPS", number: "9400111899223", status: "DELIVERED" }],
};

export interface DisputeWorld {
  disputes: Record<string, Dispute>;
  /** What check() sees if PayPal changed after the case file was built. */
  fresh?: Record<string, Dispute>;
  notes?: string[];
  /** Leave getDispute out entirely, as before C adds it. */
  noDisputeReads?: boolean;
}

export function disputeContext(world: DisputeWorld, r: MerchantRules = rules()): SkillContext {
  let reads = 0;
  const read: PayPalReads = {
    async getInvoice() {
      return null;
    },
    async recentClients() {
      return [];
    },
    ...(world.noDisputeReads
      ? {}
      : {
          getDispute: async (id: string) => {
            reads++;
            const fresh = reads > 1 ? world.fresh?.[id] : undefined;
            return fresh ?? world.disputes[id] ?? null;
          },
        }),
  };
  const db: EngineDb = {
    async remindersSent() {
      return { count: 0, lastSentAt: null };
    },
    async remindCallsToday() {
      return 0;
    },
    async merchantNotes() {
      return world.notes ?? [];
    },
  };
  return { merchant, rules: r, read, db, now: () => NOW };
}

/** A calm, honest quarantine answer. */
export const calmFacts = { claim: "not_received", requestedOutcome: "refund", mentionsTracking: false, tone: "frustrated", suspicious: false };

/** Evidence citing the delivered tracking record. */
export function evidenceAnswer(over: Partial<{ note: string; trackingRef: string | null; evidenceType: string; citations: string[] }> = {}) {
  return {
    title: "Alex says the kit never arrived; USPS shows it delivered",
    summary: "Tracking trk_1 shows delivery. Submit it as proof of fulfillment.",
    actions: [
      {
        command: "dispute.provideEvidence",
        params: {
          disputeId: notReceived.id,
          evidenceType: over.evidenceType ?? "PROOF_OF_FULFILLMENT",
          trackingRef: over.trackingRef === undefined ? "trk_1" : over.trackingRef,
          note: over.note ?? "USPS tracking 9400111899223 shows the order delivered.",
          citations: over.citations ?? ["trk_1", "PP-D-123"],
        },
        why: "trk_1 is DELIVERED.",
      },
    ],
    confidence: "high",
    questionForMerchant: null,
  };
}

export function offerAnswer(amountRef: string, note = "We're sorry it didn't reach you. We'd like to refund you.") {
  return {
    title: "Offer a refund",
    summary: "The merchant asked to refund the buyer.",
    actions: [{ command: "dispute.makeOffer", params: { disputeId: notReceived.id, offerType: "REFUND", amountRef, note }, why: "merchant-request" }],
    confidence: "high",
    questionForMerchant: null,
  };
}
