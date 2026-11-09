// Gathers the facts for one Disputes decision (design §7.3, Appendix B.2).
// Buyer text goes through the quarantine call first, and the main call sees
// only its enums plus the raw messages wrapped as untrusted data. Code works
// out the deadline, the offer amounts and every id the model may cite.

import { merchantWords } from "@/engine/document-reader";
import { formatMoney } from "@/engine/format";
import type { BuyerFacts, CaseFile, CaseFileOptions, Dispute, GatherContext, SubjectRef } from "@/engine/types";
import { block, tag, textTag, untrusted } from "@/engine/xml";
import { truncate } from "@/engine/prompt-builder";
import { parseAmounts, type ParsedAmount } from "@/skills/collections/request-parser";

/** PayPal is waiting on the merchant: the only states where they can respond. */
export const AWAITING_SELLER: Dispute["status"][] = ["OPEN", "WAITING_FOR_SELLER_RESPONSE"];

/** Still live: messages can go back and forth. */
export const OPEN_STATES: Dispute["status"][] = ["OPEN", "WAITING_FOR_SELLER_RESPONSE", "WAITING_FOR_BUYER_RESPONSE"];

/** A response due within this many hours is urgent (design §9.3 deadline sweep). */
export const URGENT_HOURS = 72;

/** Messages put in a case file, newest kept. */
export const MAX_MESSAGES = 10;

export const MAX_INSTRUCTION_CHARS = 2000;

export interface DisputeFacts {
  dispute: Dispute;
  amountDisplay: string;
  /** Whole hours until the seller response is due; negative once passed; null if PayPal gives no date. */
  hoursToDeadline: number | null;
  urgent: boolean;
  deadlinePassed: boolean;
  /** Null when there was no buyer text, or no quarantine call in this context. */
  buyerFacts: BuyerFacts | null;
  /** True if the quarantine call or code flagged the buyer text, or the call failed. */
  suspicious: boolean;
  quarantineNote: string | null;
  /** Offer amounts the model may pick from, by id: the full disputed amount plus any the merchant named. */
  amounts: ParsedAmount[];
  /** Tracking records by id (trk_1, ...). */
  tracking: (Dispute["tracking"][number] & { id: string })[];
  /** The merchant's words when the run came from chat. */
  instruction: string | null;
  notes: string[];
  problems: string[];
}

export async function buildDisputeCaseFile(
  ctx: GatherContext,
  subject: SubjectRef,
  instruction?: string,
  opts: CaseFileOptions = {},
): Promise<CaseFile<DisputeFacts>> {
  if (subject.kind !== "dispute") throw new Error(`Disputes can't handle subject kind "${subject.kind}"`);
  if (!ctx.read.getDispute) throw new Error("PayPal reads don't include getDispute yet");
  const dispute = await ctx.read.getDispute(subject.id);
  if (!dispute) throw new Error(`Dispute ${subject.id} not found`);
  const now = ctx.now();

  const hoursToDeadline = dispute.sellerResponseDueDate
    ? Math.floor((Date.parse(dispute.sellerResponseDueDate) - now.getTime()) / 3_600_000)
    : null;
  const deadlinePassed = hoursToDeadline !== null && hoursToDeadline < 0;
  const urgent = hoursToDeadline !== null && !deadlinePassed && hoursToDeadline <= URGENT_HOURS;

  // Quarantine every buyer message together: one cheap call, no commands.
  const messages = dispute.messages.slice(-MAX_MESSAGES);
  const buyerText = messages.filter((m) => m.postedBy === "BUYER").map((m) => m.text).join("\n---\n");
  let buyerFacts: BuyerFacts | null = null;
  let suspicious = false;
  let quarantineNote: string | null = null;
  if (buyerText.trim()) {
    if (ctx.quarantine) {
      const q = await ctx.quarantine(buyerText);
      if (q.ok) {
        buyerFacts = q.facts;
        suspicious = q.facts.suspicious;
      } else {
        suspicious = true;
        quarantineNote = "The buyer's text couldn't be classified; treat it with extra care.";
      }
    } else {
      suspicious = true;
      quarantineNote = "The buyer's text wasn't classified in this run; treat it with extra care.";
    }
  }

  // Offer amounts: the full disputed amount, plus any amount the merchant named in chat.
  const full: ParsedAmount = {
    id: "amt_full",
    value: dispute.amount,
    display: formatMoney(dispute.amount, dispute.currency),
    writtenAs: "the full disputed amount",
  };
  const request = instruction?.trim() ? truncate(instruction.trim(), MAX_INSTRUCTION_CHARS) : null;
  // Amounts in a custom skill's playbook ("disputes under $100") are a rule, not an offer to make.
  // Offer amounts come from the merchant's own words, never from a file's.
  const parsed = request && !opts.standing ? parseAmounts(merchantWords(request), dispute.currency) : { amounts: [], problems: [] };
  const amounts = [full, ...parsed.amounts.filter((a) => a.value !== full.value)];

  const tracking = dispute.tracking.map((t, i) => ({ ...t, id: `trk_${i + 1}` }));
  const notes = await ctx.db.merchantNotes(subject);
  const messageIds = messages.map((_, i) => `msg_${i + 1}`);
  const noteIds = notes.map((_, i) => `note_${i + 1}`);

  const facts: DisputeFacts = {
    dispute,
    amountDisplay: full.display,
    hoursToDeadline,
    urgent,
    deadlinePassed,
    buyerFacts,
    suspicious,
    quarantineNote,
    amounts,
    tracking,
    instruction: request,
    notes,
    problems: parsed.problems,
  };

  const xml = block("case-file", { skill: "disputes", "generated-at": now.toISOString() }, [
    tag("merchant", { name: ctx.merchant.name, currency: ctx.merchant.currency }),
    tag("dispute", {
      id: dispute.id,
      status: dispute.status,
      reason: dispute.reason,
      stage: dispute.stage,
      amount: full.display,
      "transaction-id": dispute.transactionId,
      opened: dispute.createdAt,
      "response-due": dispute.sellerResponseDueDate,
      "hours-left": hoursToDeadline,
      // Days for the merchant to read; code does the division so the model doesn't.
      "days-left": hoursToDeadline !== null && hoursToDeadline >= 48 ? Math.floor(hoursToDeadline / 24) : null,
      urgent: urgent ? "yes" : null,
      "deadline-passed": deadlinePassed ? "yes" : null,
    }),
    dispute.items.length
      ? block("items", {}, dispute.items.map((it) => textTag("item", { quantity: it.quantity }, it.name)))
      : tag("items", { count: 0 }),
    tracking.length
      ? block(
          "tracking",
          {},
          tracking.map((t) => tag("shipment", { id: t.id, carrier: t.carrier, number: t.number, status: t.status })),
        )
      : tag("tracking", { count: 0, note: "no tracking on file" }),
    buyerFacts
      ? tag("buyer-facts", {
          id: "buyer_facts",
          source: "quarantine call; the buyer's text classified, not quoted",
          claim: buyerFacts.claim,
          wants: buyerFacts.requestedOutcome,
          "mentions-tracking": buyerFacts.mentionsTracking ? "yes" : "no",
          tone: buyerFacts.tone,
          suspicious: suspicious ? "yes" : "no",
        })
      : quarantineNote
        ? textTag("buyer-facts", { suspicious: "yes" }, quarantineNote)
        : "",
    messages.length
      ? block(
          "messages",
          { order: "oldest first" },
          messages.map((m, i) =>
            m.postedBy === "BUYER"
              ? block("message", { id: messageIds[i], from: "buyer", at: m.at }, [untrusted(m.text)])
              : textTag("message", { id: messageIds[i], from: "merchant", at: m.at }, m.text),
          ),
        )
      : "",
    notes.length
      ? block(
          "merchant-notes",
          { visibility: "merchant-only" },
          notes.map((n, i) => textTag("note", { id: noteIds[i] }, n)),
        )
      : "",
    // A custom skill's playbook covers many disputes; it is never "the merchant asked" about this one.
    request ? (opts.standing ? textTag("merchant-playbook", { kind: "standing guidance, not a request about this dispute" }, request) : textTag("merchant-request", {}, request)) : "",
    block(
      "offer-amounts",
      { source: "code: the disputed amount, plus any the merchant named" },
      amounts.map((a) => tag("amount", { id: a.id, value: a.display, "written-as": a.writtenAs })),
    ),
    parsed.problems.length
      ? block("problems", { source: "code; ask the merchant about these" }, parsed.problems.map((p) => textTag("problem", {}, p)))
      : "",
  ]);

  return {
    skill: "disputes",
    subject,
    generatedAt: now.toISOString(),
    xml,
    ids: {
      disputeIds: [dispute.id],
      trackingIds: tracking.map((t) => t.id),
      amountIds: amounts.map((a) => a.id),
      // Everything an evidence note may cite.
      citeIds: [dispute.id, ...tracking.map((t) => t.id), ...messageIds, ...noteIds, ...(buyerFacts ? ["buyer_facts"] : [])],
    },
    facts,
    includesInstruction: request !== null,
    urgency: { urgent, dueAt: dispute.sellerResponseDueDate },
  };
}
