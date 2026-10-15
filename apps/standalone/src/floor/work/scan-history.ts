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
    "SELECT s.id AS id, s.scanned_at AS scanned_at, s.verdict AS verdict, " +
      "s.duplicate_source AS duplicate_source, s.gtin14 AS gtin14, s.serial AS serial, " +
      "(SELECT o.name FROM ref_operators AS o WHERE o.id = s.operator_id) AS operator_name, " +
      "CASE WHEN s.box_id IS NULL THEN NULL ELSE " +
      "(SELECT count(*) FROM floor_scans AS p WHERE p.host_id = s.host_id " +
      "AND p.device_id = s.device_id AND p.shift_id = s.shift_id AND p.box_id = s.box_id " +
      "AND p.verdict = 'ok' AND (p.scanned_at < s.scanned_at " +
      "OR (p.scanned_at = s.scanned_at AND p.rowid <= s.rowid))) END AS box_position " +
      "FROM floor_scans AS s WHERE s.host_id = ? AND s.device_id = ? AND s.shift_id = ? " +
      "ORDER BY s.scanned_at DESC, s.rowid DESC LIMIT ? OFFSET ?",
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
    })),
    total: count?.n ?? 0,
  };
}
