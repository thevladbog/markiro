import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { remainingSerials } from "./work/block-supply.js";

/**
 * What the floor's status bar says of the outbox (stage 2a spec §5.5): this
 * pairing's records without a receipt, the ones the host refused, and the
 * scans the host found another device's scan owns.
 */
export interface OutboxStatus {
  unsent: number;
  rejected: number;
  conflicts: number;
}

/*
 * The status bar counts the outbox after every scan, as three counts of their
 * own: one `count(*) FILTER (…)` over the table is a scan that reads every
 * record's payload (130–165 ms with 200,000 records), while each of these is
 * a seek in a partial index — `outbox_unsent` for the records without a
 * receipt, `outbox_settled` for the ones the host settled with a verdict.
 * Their text is pinned in both query-plan lists (`test/floor-schema.test.ts`
 * and `src-tauri/tests/local_db.rs`): change it in all three places.
 */
export const UNSENT_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND acked_at IS NULL";
export const REJECTED_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'rejected'";
export const CONFLICT_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'conflict'";

const countRow = z.object({ n: z.number().int().nonnegative() });

async function count(local: LocalExecutor, pairing: Pairing, sql: string): Promise<number> {
  const [row] = await local.query(sql, [pairing.hostId, pairing.deviceId], countRow);
  return row?.n ?? 0;
}

export async function readOutboxStatus(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<OutboxStatus> {
  const [unsent, rejected, conflicts] = await Promise.all([
    count(local, pairing, UNSENT_COUNT_SQL),
    count(local, pairing, REJECTED_COUNT_SQL),
    count(local, pairing, CONFLICT_COUNT_SQL),
  ]);
  return { unsent, rejected, conflicts };
}

/**
 * The oldest record this pairing has not delivered, the one the sender
 * retries first (and, when a batch fails as a whole, forever: a record is
 * never skipped, or the order the host's checks depend on would break).
 */
export const HEAD_RECORD_SQL =
  "SELECT attempts, sent_at, created_at FROM outbox WHERE host_id = ? AND device_id = ? " +
  "AND acked_at IS NULL ORDER BY seq LIMIT 1";

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const headRow = z.object({
  attempts: z.number().int().nonnegative(),
  sent_at: instant.nullable(),
  created_at: instant,
});

/** How long the delivery has been stuck, as far as the outbox itself can tell. */
export interface DeliveryStuck {
  /** Milliseconds the oldest undelivered record has waited (never negative). */
  waitedMs: number;
  /** Sends of that record so far, counted before each one goes. */
  attempts: number;
  /** Milliseconds since its last send (never negative); `null` when none was made yet. */
  sinceLastAttemptMs: number | null;
}

/**
 * What the outbox knows of a stuck delivery: the oldest undelivered record,
 * how long it has waited and how often a send carried it. `null` when
 * nothing waits. A failed read rejects.
 */
export async function readDeliveryStuck(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<DeliveryStuck | null> {
  const [row] = await local.query(HEAD_RECORD_SQL, [pairing.hostId, pairing.deviceId], headRow);
  if (row === undefined) return null;
  const since = (instant: string): number => Math.max(0, now.getTime() - Date.parse(instant));
  return {
    waitedMs: since(row.created_at),
    attempts: row.attempts,
    sinceLastAttemptMs: row.sent_at === null ? null : since(row.sent_at),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A wait as the two largest units it has, whole and rounded down, largest
 * first (`2 ч 5 мин`, `1 сут 3 ч`, `7 мин`); empty for less than a minute.
 */
export function waitUnits(ms: number): { unit: "day" | "hour" | "minute"; n: number }[] {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const units =
    days > 0
      ? [
          { unit: "day" as const, n: days },
          { unit: "hour" as const, n: hours },
        ]
      : hours > 0
        ? [
            { unit: "hour" as const, n: hours },
            { unit: "minute" as const, n: minutes },
          ]
        : [{ unit: "minute" as const, n: minutes }];
  return units.filter((part) => part.n > 0);
}

/**
 * The statement that finds the issuer prefix of a shift this pairing entered;
 * `NULL` for a shift it only listed.
 */
export const SHIFT_PREFIX_SQL =
  "SELECT snapshot ->> 'issuerPrefix' AS prefix FROM floor_shifts " +
  "WHERE host_id = ? AND device_id = ? AND id = ?";

const prefixRow = z.object({ prefix: z.string().nullable() });

/**
 * The SSCC serials this pairing has left for the boxes of a shift it entered
 * (the snapshot's issuer prefix), counted the way a box's close takes them
 * (`remainingSerials`); `null` for a shift without a snapshot.
 */
export async function readSerialsLeft(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<number | null> {
  const [row] = await local.query(
    SHIFT_PREFIX_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    prefixRow,
  );
  if (row === undefined || row.prefix === null) return null;
  return remainingSerials(local, pairing, row.prefix);
}

/**
 * This many serials or fewer are left: the bar warns. A box takes one, and the
 * station asks for a block when the newest has less than half left (stage 2a
 * spec §5.7.4), so a count this low means the host did not answer in time,
 * has no serials left, or the link is down; at zero the station cannot close
 * a box.
 */
export const SERIALS_LOW = 100;
