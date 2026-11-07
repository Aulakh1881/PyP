// The daily model budget in Postgres (gateway/budget.ts, migration 004).
// reserve() checks the cap and adds the reservation in one conditional
// update, so several workers can't overspend between them.

import type { Pool } from "pg";
import { BudgetExceeded, type SpendLedger } from "@/gateway/budget";

export class PgLedger implements SpendLedger {
  constructor(private readonly db: Pick<Pool, "query">) {}

  async reserve(usd: number, capUsd: number, purpose: string): Promise<string> {
    await this.db.query("insert into spend_ledger (day) values (current_date) on conflict (day) do nothing");
    const res = await this.db.query(
      `with booked as (
         update spend_ledger set spent_usd = spent_usd + $1
          where day = current_date and spent_usd + $1 <= $2
         returning day
       )
       insert into spend_reservations (day, reserved_usd, purpose)
       select day, $1, $3 from booked returning id`,
      [usd, capUsd, purpose],
    );
    if (!res.rows[0]) throw new BudgetExceeded(capUsd);
    return res.rows[0].id;
  }

  async settle(reservationId: string, actualUsd: number): Promise<void> {
    // Settles against the day it was reserved, so yesterday's call can't lower today's total.
    await this.db.query(
      `with r as (
         update spend_reservations set settled_usd = $2
          where id = $1 and settled_usd is null
         returning day, reserved_usd
       )
       update spend_ledger l set spent_usd = l.spent_usd + ($2 - r.reserved_usd) from r where l.day = r.day`,
      [reservationId, actualUsd],
    );
  }
}
