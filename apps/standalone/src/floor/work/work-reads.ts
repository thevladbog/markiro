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
  /** Codes this station holds in the shift's boxes: the shift's actual quantity. */
  accepted: number;
  /** Boxes of the shift closed and not taken apart. */
  closedBoxes: number;
  /** The SSCC of the box closed last, or `null`. */
  lastSscc: string | null;
}

const countRow = z.object({ n: z.number().int().nonnegative() });
const ssccRow = z.object({ sscc: z.string() });

export async function readWorkTotals(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<WorkTotals> {
  const scope = [pairing.hostId, pairing.deviceId, shiftId];
  const [openBox, accepted, closed, last] = await Promise.all([
    readOpenBox(local, pairing, shiftId),
    local.query(
      "SELECT count(*) AS n FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
      scope,
      countRow,
    ),
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
