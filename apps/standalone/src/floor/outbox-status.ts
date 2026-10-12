import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { PALLET_EXTENSION } from "./pallets/pallets.js";
import { NEWEST_BLOCK_SQL, remainingSerials } from "./work/block-supply.js";
import { BOX_EXTENSION } from "./work/box-close.js";

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
// A record a person resolved on the queue screen (plan ОЧ) is no longer counted.
export const REJECTED_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'rejected' " +
  "AND resolved_at IS NULL";
export const CONFLICT_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'conflict' " +
  "AND resolved_at IS NULL";

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

/**
 * When this pairing last settled a restore of the host (plan РК-С; `NULL`
 * while one is owed): the reconciliation reopens the acknowledged records of
 * 30 days, so the delivery they start counts from it, not from their
 * creation. Pinned with the reconciliation's reads in both query-plan lists.
 */
export const RECONCILED_AT_SQL =
  "SELECT reconciled_at FROM floor_restore_epochs WHERE host_id = ? AND device_id = ?";

const reconciledRow = z.object({ reconciled_at: instant.nullable() });

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
 * nothing waits. After a settled restore the wait counts from the
 * reconciliation when the record is older, and a send before it is no
 * attempt of this delivery (`sinceLastAttemptMs` is `null`). A failed read
 * rejects.
 */
export async function readDeliveryStuck(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<DeliveryStuck | null> {
  const key = [pairing.hostId, pairing.deviceId];
  const [[row], [restore]] = await Promise.all([
    local.query(HEAD_RECORD_SQL, key, headRow),
    local.query(RECONCILED_AT_SQL, key, reconciledRow),
  ]);
  if (row === undefined) return null;
  const reconciledAt =
    restore === undefined || restore.reconciled_at === null
      ? null
      : Date.parse(restore.reconciled_at);
  const since = (at: number): number => Math.max(0, now.getTime() - at);
  const created = Date.parse(row.created_at);
  const sent = row.sent_at === null ? null : Date.parse(row.sent_at);
  return {
    waitedMs: since(reconciledAt === null ? created : Math.max(created, reconciledAt)),
    attempts: row.attempts,
    sinceLastAttemptMs:
      sent === null || (reconciledAt !== null && sent < reconciledAt) ? null : since(sent),
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
 * The issuer prefix of a shift this pairing entered (`NULL` for a shift it only
 * listed) and whether it has pallets.
 */
export const SHIFT_STOCK_SQL =
  "SELECT snapshot ->> 'issuerPrefix' AS prefix, pallets_enabled FROM floor_shifts " +
  "WHERE host_id = ? AND device_id = ? AND id = ?";

const stockRow = z.object({ prefix: z.string().nullable(), pallets_enabled: z.number().int() });
const newestRow = z.object({
  from_serial: z.number().int(),
  to_serial: z.number().int(),
  next_serial: z.number().int(),
});

/** How low a stock of serials is (pilot spec §9.3, plan ОЧ). */
export type StockLevel = "ok" | "quarter" | "tenth" | "last" | "none";

/** A quarter and a tenth of a block: the thresholds of pilot spec §9.3. */
const QUARTER = 4;
const TENTH = 10;

/**
 * The level of `left` serials against the newest block's size: none, the last
 * one, a tenth of the block or less, a quarter or less. Online the station asks
 * for a block at half (stage 2a spec §5.7.4), so a level below `ok` means the
 * host did not answer, has no serials, or the link is down. Without a block to
 * measure by only the last serial and none say anything.
 */
export function stockLevel(left: number, blockSize: number | null): StockLevel {
  if (left <= 0) return "none";
  if (left === 1) return "last";
  if (blockSize === null || blockSize <= 0) return "ok";
  if (left * TENTH <= blockSize) return "tenth";
  if (left * QUARTER <= blockSize) return "quarter";
  return "ok";
}

export interface SerialStock {
  left: number;
  level: StockLevel;
}

/** The serials of a shift's boxes and, in a shift with pallets, of its pallets. */
export interface ShiftStock {
  boxes: SerialStock;
  pallets: SerialStock | null;
}

async function serialStock(
  local: LocalExecutor,
  pairing: Pairing,
  prefix: string,
  extension: number,
): Promise<SerialStock> {
  const [left, [newest]] = await Promise.all([
    remainingSerials(local, pairing, prefix, extension),
    local.query(NEWEST_BLOCK_SQL, [pairing.hostId, pairing.deviceId, prefix, extension], newestRow),
  ]);
  const size = newest === undefined ? null : newest.to_serial - newest.from_serial + 1;
  return { left, level: stockLevel(left, size) };
}

/**
 * The SSCC serials this pairing has left for a shift it entered, counted the
 * way a close takes them (`remainingSerials`): its boxes', and its pallets'
 * when it has pallets, each with its level; `null` for a shift without a
 * snapshot.
 */
export async function readShiftStock(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ShiftStock | null> {
  const [row] = await local.query(
    SHIFT_STOCK_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    stockRow,
  );
  if (row === undefined || row.prefix === null) return null;
  const boxes = await serialStock(local, pairing, row.prefix, BOX_EXTENSION);
  const pallets =
    row.pallets_enabled === 1
      ? await serialStock(local, pairing, row.prefix, PALLET_EXTENSION)
      : null;
  return { boxes, pallets };
}

/** The blocks the host gave this pairing that the station did not take (plan ОЧ). */
export const BLOCK_DROPS_COUNT_SQL =
  "SELECT count(*) AS n FROM floor_block_drops WHERE host_id = ? AND device_id = ?";

export async function readBlockDrops(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const [row] = await local.query(
    BLOCK_DROPS_COUNT_SQL,
    [pairing.hostId, pairing.deviceId],
    countRow,
  );
  return row?.n ?? 0;
}
