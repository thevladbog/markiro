import { z } from "zod";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/** One scan of a shift as this station recorded it (`floor_scans`), ready to list. */
export interface ScanHistoryRow {
  id: string;
  /** The UTC instant the code was scanned. */
  scannedAt: string;
  verdict: "ok" | "duplicate" | "wrong_gtin" | "invalid";
  /** Where a duplicate was found: on this station or on the host. */
  duplicateSource: "local" | "host" | null;
  operatorName: string | null;
  /** The place the code took in its box (1, 2, 3...), `null` for a scan that went into no box. */
  boxPosition: number | null;
  /** The code as the list shows it: the GTIN and the tail of the serial, never the whole code. */
  maskedCode: string | null;
  /** The GTIN-14 and the serial (GS1 AI 21) of a marking code; `null` for a scan that was none. */
  gtin14: string | null;
  serial: string | null;
}

const row = z.object({
  id: z.string(),
  scanned_at: z.string(),
  verdict: z.enum(["ok", "duplicate", "wrong_gtin", "invalid"]),
  duplicate_source: z.enum(["local", "host"]).nullable(),
  gtin14: z.string().nullable(),
  serial: z.string().nullable(),
  operator_name: z.string().nullable(),
  box_position: z.number().int().nonnegative().nullable(),
});

/** The characters of the serial a listed code keeps. */
const SERIAL_TAIL = 4;

/**
 * A code of marking as a list shows it: its GTIN and the last characters of
 * its serial, the rest hidden (the whole serial may identify a unit, and a
 * history on a shared screen has no need of it).
 */
export function maskCode(gtin14: string | null, serial: string | null): string | null {
  if (gtin14 === null || serial === null) return null;
  const tail = serial.length <= SERIAL_TAIL ? serial : serial.slice(-SERIAL_TAIL);
  return `${gtin14} …${tail}`;
}

/** The serial's characters a compact line keeps (its head is cut, never its end). */
export const SERIAL_SHOWN = 14;
/** The most a GS1 serial has (AI 21), what the full history shows whole. */
export const SERIAL_FULL = 20;
/** The digits of the GTIN a line keeps beside the serial. */
const GTIN_SHORT = 6;

/** What a scan's code line shows: the serial first, the GTIN short and small beside it. */
export interface CodeDisplay {
  /** The serial, its head cut to `…` + the last characters when longer than `limit`. */
  serial: string;
  /** `…` and the last digits of the GTIN. */
  gtin: string;
  /** The whole GTIN and serial, for the title and the screen reader. */
  full: string;
}

/**
 * How a marking code reads on a line: «…900017 · 2L=o8Zk3VqXp1», the serial (GS1 AI 21, from
 * the shared parser at scan time) as the main part. A serial longer than `limit` loses its
 * head, so its end, the part that tells units apart, stays. Without a serial (a scan that is no
 * marking code) the answer is `null` and the caller keeps its old line.
 */
export function codeDisplay(
  gtin14: string | null,
  serial: string | null,
  limit: number = SERIAL_SHOWN,
): CodeDisplay | null {
  if (serial === null || serial === "") return null;
  const shown = serial.length <= limit ? serial : `…${serial.slice(-(limit - 1))}`;
  const gtin = gtin14 === null ? "" : `…${gtin14.slice(-GTIN_SHORT)}`;
  return {
    serial: shown,
    gtin,
    full: gtin14 === null ? serial : `${gtin14} ${serial}`,
  };
}

/**
 * The newest-first slice of a shift's scans (`readScanHistory`). The page is chosen first,
 * by the rowids alone (`page`: sorted and limited on its own, which SQLite never flattens into
 * the join), and only its rows are read back and given the operator's name and the place in
 * the box. The old text computed the place, a correlated count over the box's scans, for every
 * scan of the shift before the sort and the limit: quadratic in the shift's scans (1.2 s at
 * 4 000, 12.6 s at 10 000 on a Mac), on every scan, and the code of the last scan waited for it.
 * Same columns, order and rows as before (`test/floor-scan-history-read.test.ts` keeps the old
 * text as its oracle); the plan is pinned on both SQLite builds.
 */
export const SCAN_HISTORY_SQL =
  "SELECT s.id AS id, s.scanned_at AS scanned_at, s.verdict AS verdict, " +
  "s.duplicate_source AS duplicate_source, s.gtin14 AS gtin14, s.serial AS serial, " +
  "(SELECT o.name FROM ref_operators AS o WHERE o.id = s.operator_id) AS operator_name, " +
  "CASE WHEN s.box_id IS NULL THEN NULL ELSE " +
  "(SELECT count(*) FROM floor_scans AS p WHERE p.host_id = s.host_id " +
  "AND p.device_id = s.device_id AND p.shift_id = s.shift_id AND p.box_id = s.box_id " +
  "AND p.verdict = 'ok' AND (p.scanned_at < s.scanned_at " +
  "OR (p.scanned_at = s.scanned_at AND p.rowid <= s.rowid))) END AS box_position " +
  "FROM (SELECT rowid AS page_rowid FROM floor_scans " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
  "ORDER BY scanned_at DESC, rowid DESC LIMIT ? OFFSET ?) AS page " +
  "JOIN floor_scans AS s ON s.rowid = page.page_rowid " +
  "ORDER BY s.scanned_at DESC, s.rowid DESC";

/**
 * The newest-first slice of the shift's scans, with the operator's name from
 * the station's roster copy and the place an accepted code took in its box.
 * Every figure comes from this station's own facts (`floor_scans`); nothing is
 * asked of the host. The place counts the accepted scans of the same box up to
 * this one by time, then by insertion order.
 */
export async function readScanHistory(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
  slice: { limit: number; offset: number },
): Promise<{ rows: ScanHistoryRow[]; total: number }> {
  const rows = await local.query(
    SCAN_HISTORY_SQL,
    [pairing.hostId, pairing.deviceId, shiftId, slice.limit, slice.offset],
    row,
  );
  const [count] = await local.query(
    "SELECT count(*) AS n FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    z.object({ n: z.number().int().nonnegative() }),
  );
  return {
    rows: rows.map((each) => ({
      id: each.id,
      scannedAt: each.scanned_at,
      verdict: each.verdict,
      duplicateSource: each.duplicate_source,
      operatorName: each.operator_name,
      boxPosition: each.box_position,
      maskedCode: maskCode(each.gtin14, each.serial),
      gtin14: each.gtin14,
      serial: each.serial,
    })),
    total: count?.n ?? 0,
  };
}
