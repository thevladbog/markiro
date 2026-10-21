import { z } from "zod";

import { OPEN_JOB_SQL } from "../floor/print/print-jobs.js";
import { UNRESOLVED_UNIT_LABEL_SQL } from "../floor/unit-labels/unit-label-store.js";
import { LocalDbError, type LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/**
 * How long the station keeps a shift's records once the host has taken its
 * close (stage 2a spec, decision 31; question В6): 30 days.
 */
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** How often the pass runs while the app is open, besides once at its start. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The tables of a shift's own records, which carry its `shift_id`: the
 * retention deletes their rows with the shift's copy. A later plan's table
 * of a shift's records joins this list, or a test that reads every table of
 * the database fails; the pallets' plan (ПЛ-Ц) added `floor_pallets` and
 * `floor_pallet_exceptions`, plan РЕЖ part B `floor_unit_labels` (whose
 * fields and bytes hold the full code: the whole row goes).
 */
export const RETAINED_TABLES = [
  "floor_scans",
  "floor_exceptions",
  "floor_pallet_exceptions",
  "floor_codes",
  "floor_print_jobs",
  "floor_boxes",
  "floor_pallets",
  "floor_unit_labels",
  "outbox",
] as const;

const dueRow = z.object({ id: z.string() });

/**
 * When a shift of the pairing is done with on this station: the host took
 * this station's close (its `shift_closed` answered `accepted`,
 * `alreadyClosed` too — what makes the copy `closed`) at least 30 days
 * before the cutoff, every record of the shift has its receipt, no refused or
 * conflicting record of it waits for a person (plan ОЧ: a refusal leaves the
 * station only when someone resolved it on the queue screen), no label of
 * it waits, and no unit label of it is unresolved (plan РЕЖ part B: its
 * outcome may be unknown). The last asks the pairing's one unresolved job
 * through its unique index (`INDEXED BY`: that index is the pairing's, a
 * station having one unresolved job whatever its shift, and the planner
 * would rather walk the shift's every job through `floor_unit_labels_shift`).
 * Parameters: host id, device id, the cutoff (an instant as
 * `Date.toISOString` writes it, as `acked_at` is).
 */
const DONE_WITH =
  "s.host_id = ? AND s.device_id = ? " +
  "AND EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id AND o.device_id = s.device_id " +
  "AND o.shift_id = s.id AND o.kind = 'shift_closed' AND o.outcome = 'accepted' " +
  "AND o.acked_at <= ?) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.host_id = s.host_id " +
  "AND r.device_id = s.device_id AND r.shift_id = s.id " +
  "AND r.outcome IN ('rejected', 'conflict') AND r.resolved_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = s.host_id " +
  `AND j.device_id = s.device_id AND j.shift_id = s.id AND ${OPEN_JOB_SQL}) ` +
  "AND NOT EXISTS (SELECT 1 FROM floor_unit_labels l INDEXED BY floor_unit_labels_unresolved " +
  "WHERE l.host_id = s.host_id " +
  `AND l.device_id = s.device_id AND l.shift_id = s.id AND ${UNRESOLVED_UNIT_LABEL_SQL})`;

/**
 * The shifts of the pairing that are done with; parameters: host id, device
 * id, cutoff. The same conditions as `DONE_WITH`, but driven from the
 * accepted closes instead of from the copies: the pass walks the pairing's
 * accepted records once (`outbox_settled`) and checks each close's shift by
 * its keys, where asking per copy walked them once for every shift (shifts ×
 * records, 6.5 s at 600 000 rows). `DISTINCT` because a shift may hold more
 * than one accepted close; the order of the answer is not part of the
 * contract.
 */
export const DUE_SHIFTS_SQL =
  "SELECT DISTINCT o.shift_id AS id FROM outbox o WHERE o.host_id = ? AND o.device_id = ? " +
  "AND o.outcome = 'accepted' AND o.kind = 'shift_closed' AND o.acked_at <= ? " +
  "AND EXISTS (SELECT 1 FROM floor_shifts s WHERE s.host_id = o.host_id " +
  "AND s.device_id = o.device_id AND s.id = o.shift_id) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox u WHERE u.host_id = o.host_id " +
  "AND u.device_id = o.device_id AND u.shift_id = o.shift_id AND u.acked_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.host_id = o.host_id " +
  "AND r.device_id = o.device_id AND r.shift_id = o.shift_id " +
  "AND r.outcome IN ('rejected', 'conflict') AND r.resolved_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE j.host_id = o.host_id " +
  `AND j.device_id = o.device_id AND j.shift_id = o.shift_id AND ${OPEN_JOB_SQL}) ` +
  "AND NOT EXISTS (SELECT 1 FROM floor_unit_labels l INDEXED BY floor_unit_labels_unresolved " +
  "WHERE l.host_id = o.host_id " +
  `AND l.device_id = o.device_id AND l.shift_id = o.shift_id AND ${UNRESOLVED_UNIT_LABEL_SQL})`;

/**
 * The shift's copy goes while the shift is still done with; parameters: shift
 * id, host id, device id, cutoff.
 */
export const PURGE_COPY_SQL = `DELETE FROM floor_shifts AS s WHERE s.id = ? AND ${DONE_WITH}`;

/** One table's rows of the shift; parameters: host id, device id, shift id. */
export const purgeTableSql = (table: (typeof RETAINED_TABLES)[number]): string =>
  `DELETE FROM ${table} WHERE host_id = ? AND device_id = ? AND shift_id = ?`;

/**
 * Deletes the records of this pairing's shifts done with for 30 days
 * (stage 2a spec, decision 31): the copy, its scans, exceptions, codes,
 * print jobs, boxes, pallets, pallet exceptions, unit labels and outbox records, one shift
 * per transaction. The copy
 * goes first and only while the shift is still done with, so a shift that
 * took a record meanwhile keeps everything. The SSCC blocks and the
 * requests for them stay: a restore of the host asks the station for its
 * blocks (plan РК). Another pairing's rows are never touched. Answers how
 * many shifts went.
 */
export async function purgeAcknowledged(
  local: LocalExecutor,
  pairing: Pairing,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  const { hostId, deviceId } = pairing;
  const due = await local.query(DUE_SHIFTS_SQL, [hostId, deviceId, cutoff], dueRow);
  let purged = 0;
  for (const { id } of due) {
    try {
      await local.transaction([
        {
          sql: PURGE_COPY_SQL,
          values: [id, hostId, deviceId, cutoff],
          expectedChanges: 1,
        },
        ...RETAINED_TABLES.map((table) => ({
          sql: purgeTableSql(table),
          values: [hostId, deviceId, id],
        })),
      ]);
      purged += 1;
    } catch (error) {
      // The shift took a record meanwhile: it stays, whole, for a later pass.
      if (!(error instanceof LocalDbError && error.code === "changes_mismatch")) throw error;
    }
  }
  return purged;
}

/** The SSCC prefix of demo shifts (spec 2026-10-21, decision О4): the host's `DEMO_PREFIX`. */
export const DEMO_SSCC_PREFIX = "290000000";

/**
 * A demo shift of the pairing whose demo data the office removed: entered here (a planned copy
 * goes with the host's list), of the demo prefix, its product gone from the copies (it left the
 * feed as a tombstone), and every record of it answered — the host acknowledges a late record
 * of a removed demo shift, so the queue drains first. Parameters: host id, device id.
 */
const REMOVED_DEMO =
  "s.host_id = ? AND s.device_id = ? AND s.entered_at IS NOT NULL " +
  `AND s.snapshot ->> 'issuerPrefix' = '${DEMO_SSCC_PREFIX}' ` +
  "AND NOT EXISTS (SELECT 1 FROM ref_products p WHERE p.id = s.product_id) " +
  "AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id " +
  "AND o.device_id = s.device_id AND o.shift_id = s.id AND o.acked_at IS NULL)";

export const REMOVED_DEMO_SQL = `SELECT s.id FROM floor_shifts s WHERE ${REMOVED_DEMO}`;

/**
 * Deletes this pairing's copies of removed demo shifts at once, with every record of them
 * (spec 2026-10-21: «Удалить демо-данные» leaves no trace on the station either), one shift per
 * transaction, the copy first and only while it still qualifies. Answers how many went.
 */
export async function purgeRemovedDemo(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const { hostId, deviceId } = pairing;
  const due = await local.query(REMOVED_DEMO_SQL, [hostId, deviceId], dueRow);
  let purged = 0;
  for (const { id } of due) {
    try {
      await local.transaction([
        {
          sql: `DELETE FROM floor_shifts AS s WHERE s.id = ? AND ${REMOVED_DEMO}`,
          values: [id, hostId, deviceId],
          expectedChanges: 1,
        },
        ...RETAINED_TABLES.map((table) => ({
          sql: purgeTableSql(table),
          values: [hostId, deviceId, id],
        })),
      ]);
      purged += 1;
    } catch (error) {
      if (!(error instanceof LocalDbError && error.code === "changes_mismatch")) throw error;
    }
  }
  return purged;
}

/** A repeating timer: calls `fire` every `ms`; returns the function that stops it. */
export type Every = (ms: number, fire: () => void) => () => void;

const realEvery: Every = (ms, fire) => {
  const timer = setInterval(fire, ms);
  return () => clearInterval(timer);
};

/**
 * Runs the retention pass now and every hour after (stage 2a spec §5.5),
 * one at a time: a pass still running when the hour comes is not doubled. A
 * pass that fails leaves everything as it was, and the next one tries again.
 * Returns the function that stops it.
 */
export function scheduleRetention(run: () => Promise<unknown>, every: Every = realEvery) {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    run().then(
      () => {
        running = false;
      },
      () => {
        running = false;
      },
    );
  };
  pass();
  return every(RETENTION_INTERVAL_MS, pass);
}
