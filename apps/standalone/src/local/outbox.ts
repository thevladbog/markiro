import { z } from "zod";

import type { LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * How many records have no receipt (`acked_at IS NULL`): those of the outbox
 * (migration `0006`) and those of the warehouse reprint's `wh_outbox` (migration
 * `0012`, plan СКЛ) — the pairing's, or with `null` (the pairing file is
 * unreadable) every pairing's, as the shell counts them before a forget
 * (`device_forget`, `unsent_facts`). `null` when the database cannot be read.
 */
export async function countUnsentRecords(
  local: LocalExecutor,
  pairing: Pairing | null,
): Promise<number | null> {
  try {
    const [row] =
      pairing === null
        ? await local.query(
            "SELECT (SELECT count(*) FROM outbox WHERE acked_at IS NULL) + " +
              "(SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL) AS n",
            [],
            countRow,
          )
        : await local.query(
            "SELECT (SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? " +
              "AND device_id = ?) + (SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL " +
              "AND host_id = ? AND device_id = ?) AS n",
            [pairing.hostId, pairing.deviceId, pairing.hostId, pairing.deviceId],
            countRow,
          );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}
