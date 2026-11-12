import { z } from "zod";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readCompletedSetCount } from "../work/set-assembly.js";
import type { ShiftCopy } from "./shift-copies.js";
import { SHIFT_CODES_SQL } from "../work/work-reads.js";

const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * The units or sets this station holds in each shift (the work screen's «Принято»), for the hub's
 * progress bars: the work screen's own count (`SHIFT_CODES_SQL`, a seek in `floor_codes_shift`).
 * A shift whose count cannot be read is left out, never guessed: its card shows no progress, and
 * the list does not fail with it.
 */
export async function readAcceptedCounts(
  local: LocalExecutor,
  pairing: Pairing,
  shifts: readonly Pick<ShiftCopy, "id" | "setAssembly">[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(
    shifts.map(async ({ id, setAssembly }) => {
      try {
        if (setAssembly) {
          counts.set(id, await readCompletedSetCount(local, pairing, id));
          return;
        }
        const [row] = await local.query(
          SHIFT_CODES_SQL,
          [pairing.hostId, pairing.deviceId, id],
          countRow,
        );
        if (row !== undefined) counts.set(id, row.n);
      } catch {
        // No count: no progress row.
      }
    }),
  );
  return counts;
}
