import { z } from "zod";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/** The open box of a shift (`floor_boxes`, one at most): the scans go into it. */
export interface OpenBox {
  id: string;
  openedAt: string;
  itemCount: number;
}

const openBoxRow = z.object({
  id: z.string(),
  opened_at: z.string(),
  item_count: z.number().int().nonnegative(),
});

/** This pairing's open box of the shift, or `null`. */
export async function readOpenBox(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<OpenBox | null> {
  const [row] = await local.query(
    "SELECT id, opened_at, item_count FROM floor_boxes " +
      "WHERE host_id = ? AND device_id = ? AND shift_id = ? AND closed_at IS NULL",
    [pairing.hostId, pairing.deviceId, shiftId],
    openBoxRow,
  );
  return row === undefined
    ? null
    : { id: row.id, openedAt: row.opened_at, itemCount: row.item_count };
}

/** What the work screen shows of the shift, from this station's own records. */
export interface WorkTotals {
  openBox: OpenBox | null;
  /** Codes this station holds in the shift, in its boxes or in none (a validation shift's): its actual quantity. */
  accepted: number;
  /** Boxes of the shift closed and not taken apart. */
  closedBoxes: number;
  /** The SSCC of the box closed last, or `null`. */
  lastSscc: string | null;
}

/**
 * The codes this station holds in a shift: the work screen's accepted count, of a validation
 * shift too, whose codes have no box (plan РЕЖ, migration `0014`). Searches `floor_codes_shift`;
 * pinned with this exact text in `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`.
 */
export const SHIFT_CODES_SQL =
  "SELECT count(*) AS n FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?";

const countRow = z.object({ n: z.number().int().nonnegative() });
const ssccRow = z.object({ sscc: z.string() });

/**
 * The codes this station holds in a shift that the host does not count for it (plan 2b, final
 * review I2): the scan's record was answered `conflict` (an earlier scan of another device owns
 * the code) or `rejected`, or the host displaced it since (`floor_displacements`, learned at the
 * next notice read). The code stays in `floor_codes` (its box, its digest), so the whole shift's
 * count (`sharedCount`) takes these off this station's own. The codes of the shift through
 * `floor_codes_shift`, each record by its own key. Parameters: host id, device id, shift id.
 */
export const SHIFT_LOST_CODES_SQL =
  "SELECT count(*) AS n FROM floor_codes c WHERE c.host_id = ? AND c.device_id = ? " +
  "AND c.shift_id = ? AND (EXISTS (SELECT 1 FROM outbox o WHERE o.id = c.scan_id " +
  "AND o.outcome IN ('conflict', 'rejected')) OR EXISTS (SELECT 1 FROM floor_displacements d " +
  "WHERE d.host_id = c.host_id AND d.device_id = c.device_id AND d.record_id = c.scan_id))";

export async function readLostCodes(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<number> {
  const [row] = await local.query(
    SHIFT_LOST_CODES_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    countRow,
  );
  return row?.n ?? 0;
}

export async function readWorkTotals(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<WorkTotals> {
  const scope = [pairing.hostId, pairing.deviceId, shiftId];
  const [openBox, accepted, closed, last] = await Promise.all([
    readOpenBox(local, pairing, shiftId),
    local.query(SHIFT_CODES_SQL, scope, countRow),
    local.query(
      "SELECT count(*) AS n FROM floor_boxes WHERE host_id = ? AND device_id = ? " +
        "AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL",
      scope,
      countRow,
    ),
    local.query(
      "SELECT sscc FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
        "AND closed_at IS NOT NULL ORDER BY closed_at DESC, serial DESC LIMIT 1",
      scope,
      ssccRow,
    ),
  ]);
  return {
    openBox,
    accepted: accepted[0]?.n ?? 0,
    closedBoxes: closed[0]?.n ?? 0,
    lastSscc: last[0]?.sscc ?? null,
  };
}

/** A validation shift's refused scans on this station (plan РЕЖ): its panel's figures. */
export interface ValidationCounts {
  /** Codes refused as taken already, here or on the host. */
  duplicates: number;
  /** Codes of another product and scans that are no code of marking. */
  errors: number;
}

/**
 * The refused scans of a shift on this station, by kind, from its journal (`floor_scans`); one
 * row, searched through `floor_scans_shift`. Pinned with this exact text in
 * `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`. Parameters: host id, device id,
 * shift id.
 */
export const VALIDATION_COUNTS_SQL =
  "SELECT coalesce(sum(verdict = 'duplicate'), 0) AS duplicates, " +
  "coalesce(sum(verdict IN ('wrong_gtin', 'invalid')), 0) AS errors FROM floor_scans " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ?";

const countsRow = z.object({
  duplicates: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

export async function readValidationCounts(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ValidationCounts> {
  const [row] = await local.query(
    VALIDATION_COUNTS_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    countsRow,
  );
  return { duplicates: row?.duplicates ?? 0, errors: row?.errors ?? 0 };
}

const serialRow = z.object({ serial: z.string() });

/**
 * The serials (GS1 AI 21) of the codes in the open box, in the order they took their places
 * (the cell numbers 1, 2, 3...): from `floor_codes` of the box joined to its scan. A code taken
 * out of the box (an exception) is no longer in `floor_codes`, so its place is free again.
 */
export async function readOpenBoxSerials(
  local: LocalExecutor,
  pairing: Pairing,
  boxId: string,
): Promise<string[]> {
  const rows = await local.query(
    "SELECT s.serial AS serial FROM floor_codes AS c JOIN floor_scans AS s ON s.id = c.scan_id " +
      "WHERE c.host_id = ? AND c.device_id = ? AND c.box_id = ? AND s.serial IS NOT NULL " +
      "ORDER BY c.scanned_at, c.rowid",
    [pairing.hostId, pairing.deviceId, boxId],
    serialRow,
  );
  return rows.map((row) => row.serial);
}
