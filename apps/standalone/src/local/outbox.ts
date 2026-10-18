import { z } from "zod";

import type { LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

const countRow = z.object({ n: z.number().int().nonnegative() });

/**
 * The records without a receipt of one pairing, in both outboxes. Parameters:
 * host id, device id, host id, device id. Each count reads only the partial
 * `*_unsent` index (plans pinned in `test/floor-schema.test.ts` and the
 * shell's `tests/local_db.rs`).
 */
export const FORGET_UNSENT_SQL =
  "SELECT (SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? " +
  "AND device_id = ?) + (SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL " +
  "AND host_id = ? AND device_id = ?) AS n";

/**
 * The same of every pairing (the pairing file is unreadable): the `*_unsent` indexes whole.
 * `INDEXED BY`: since migration `0010` (plan ХП) the planner prefers the covering `outbox_shift`,
 * which walks every record of the table, the settled ones too (the same reason as in
 * `STRANDED_COUNT_SQL`).
 */
export const FORGET_UNSENT_ANY_SQL =
  "SELECT (SELECT count(*) FROM outbox INDEXED BY outbox_unsent WHERE acked_at IS NULL) + " +
  "(SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL) AS n";

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
        ? await local.query(FORGET_UNSENT_ANY_SQL, [], countRow)
        : await local.query(
            FORGET_UNSENT_SQL,
            [pairing.hostId, pairing.deviceId, pairing.hostId, pairing.deviceId],
            countRow,
          );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}
