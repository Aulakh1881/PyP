// The merchant's controls (design §4.3, §8.1): the kill switch, the undo window
// and one dial per command (Off / Ask me / Auto). The rules for what a dial may be
// live here, in code: a never-Auto command can't be set to Auto, and merchant.ask
// (a question) is always a card, so it isn't listed at all.

import type { Pool } from "pg";
import { ALWAYS_ASK, ruleFor } from "@/engine/policy";
import { SKILLS } from "@/engine/registry";
import type { CommandId, SkillId } from "@/engine/types";
import { loadMerchant } from "./store";

type Db = Pick<Pool, "query">;
export type Dial = "off" | "ask" | "auto";
const DIALS: Dial[] = ["off", "ask", "auto"];

/** What each dial is called on the controls panel, in the merchant's words. */
const LABEL: Record<string, string> = {
  "invoice.sendReminder": "Send payment reminders",
  "invoice.scheduleFollowUp": "Look at overdue invoices again later",
  "invoice.createAndSend": "Create and send invoices from chat",
  "invoice.cancel": "Cancel unpaid invoices",
  "invoice.suggestAutoReminders": "Suggest PayPal's own auto-reminders",
  "dispute.provideEvidence": "Submit evidence in disputes",
  "dispute.sendMessage": "Message buyers in disputes",
  "dispute.makeOffer": "Offer refunds in disputes",
  "dispute.acceptClaim": "Accept dispute claims",
};

export const UNDO_MAX_S = 600;

export interface CommandControl {
  id: CommandId;
  skill: SkillId;
  label: string;
  dial: Dial;
  /** False for never-Auto commands (money, or a typed chat request). */
  canAuto: boolean;
}

export interface Controls {
  killSwitch: boolean;
  undoSeconds: number;
  commands: CommandControl[];
}

export async function getControls(db: Db, merchantId: string): Promise<Controls> {
  const { rules } = await loadMerchant(db, merchantId);
  const commands: CommandControl[] = [];
  for (const skill of Object.values(SKILLS)) {
    for (const cmd of skill.commands) {
      if (ALWAYS_ASK.includes(cmd.id) || commands.some((c) => c.id === cmd.id)) continue;
      commands.push({
        id: cmd.id,
        skill: skill.id,
        label: LABEL[cmd.id] ?? cmd.description,
        dial: ruleFor(cmd.id, rules, skill).dial as Dial,
        canAuto: !skill.policy.neverAuto.includes(cmd.id),
      });
    }
  }
  return { killSwitch: rules.killSwitch, undoSeconds: rules.undoSeconds, commands };
}

export interface ControlsChange {
  killSwitch?: boolean;
  undoSeconds?: number;
  dials?: Record<string, Dial>;
}

/** Applies a change, all or nothing. Returns the new controls, or what was wrong. */
export async function updateControls(
  pool: Pool,
  merchantId: string,
  change: ControlsChange,
  actor = "merchant",
): Promise<{ ok: true; controls: Controls } | { ok: false; error: string }> {
  const current = await getControls(pool, merchantId);
  if (change.killSwitch !== undefined && typeof change.killSwitch !== "boolean") return { ok: false, error: "killSwitch must be true or false" };
  if (change.undoSeconds !== undefined) {
    const s = change.undoSeconds;
    if (!Number.isInteger(s) || s < 0 || s > UNDO_MAX_S) return { ok: false, error: `The undo window must be 0 to ${UNDO_MAX_S} seconds` };
  }
  for (const [id, dial] of Object.entries(change.dials ?? {})) {
    const cmd = current.commands.find((c) => c.id === id);
    if (!cmd) return { ok: false, error: `${id} has no dial` };
    if (!DIALS.includes(dial)) return { ok: false, error: `${dial} isn't a dial setting` };
    if (dial === "auto" && !cmd.canAuto) return { ok: false, error: `"${cmd.label}" always needs your approval; it can't be Auto` };
  }

  const log: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (change.killSwitch !== undefined && change.killSwitch !== current.killSwitch) {
      await client.query("update merchants set kill_switch = $2 where id = $1", [merchantId, change.killSwitch]);
      log.push(change.killSwitch ? "Kill switch on: Pyp is paused and sends nothing" : "Kill switch off: Pyp is running again");
    }
    if (change.undoSeconds !== undefined && change.undoSeconds !== current.undoSeconds) {
      await client.query("update merchants set undo_window_s = $2 where id = $1", [merchantId, change.undoSeconds]);
      log.push(`Undo window set to ${change.undoSeconds} s`);
    }
    for (const [id, dial] of Object.entries(change.dials ?? {})) {
      const cmd = current.commands.find((c) => c.id === id)!;
      if (cmd.dial === dial) continue;
      await client.query(
        `insert into rules (merchant_id, command_id, dial) values ($1, $2, $3)
         on conflict (merchant_id, command_id) do update set dial = excluded.dial`,
        [merchantId, id, dial],
      );
      log.push(`"${cmd.label}" set to ${dial === "ask" ? "Ask me" : dial === "auto" ? "Auto" : "Off"}`);
    }
    for (const summary of log) {
      await client.query("insert into activity_log (merchant_id, actor, summary, refs_json) values ($1, $2, $3, '{}')", [merchantId, actor, summary]);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  return { ok: true, controls: await getControls(pool, merchantId) };
}
