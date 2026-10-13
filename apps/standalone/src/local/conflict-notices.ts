import { z } from "zod";

import type { HostApi } from "../host/api.js";
import { HostError } from "../host/client.js";
import type { DeviceDisplacement } from "../host/review.js";
import type { LocalExecutor } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/** The most record ids one status request names (`MAX_CONFLICT_STATUS_RECORDS`). */
export const NOTICE_STATUS_CHUNK = 200;

/**
 * This pairing's records whose conflict, or whose displacement, nobody
 * resolved yet; parameters: host id, device id, host id, device id.
 */
export const OPEN_NOTICE_IDS_SQL =
  "SELECT id FROM outbox WHERE host_id = ? AND device_id = ? AND outcome = 'conflict' " +
  "AND resolved_at IS NULL UNION SELECT record_id FROM floor_displacements " +
  "WHERE host_id = ? AND device_id = ? AND resolved_at IS NULL";

/**
 * The office reviewed these conflicts: the records are resolved by this
 * station, by nobody of it (`resolved_by` NULL). The pluses look each record
 * up by its own key, as the sender's statements do. Parameters: the instant,
 * the JSON list of `{recordId, reviewedAt}`, host id, device id.
 */
export const APPLY_REVIEWED_OUTBOX_SQL =
  "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = NULL, " +
  "office_reviewed_at = r.value ->> 'reviewedAt' FROM json_each(?) AS r " +
  "WHERE outbox.id = r.value ->> 'recordId' AND +outbox.host_id = ? AND +outbox.device_id = ? " +
  "AND +outbox.outcome = 'conflict' AND outbox.resolved_at IS NULL";

/** The same for displacements; parameters as `APPLY_REVIEWED_OUTBOX_SQL`. */
export const APPLY_REVIEWED_DISPLACEMENTS_SQL =
  "UPDATE floor_displacements SET resolved_at = ?, office_reviewed_at = r.value ->> 'reviewedAt' " +
  "FROM json_each(?) AS r WHERE floor_displacements.host_id = ? " +
  "AND floor_displacements.device_id = ? AND floor_displacements.record_id = r.value ->> 'recordId' " +
  "AND floor_displacements.resolved_at IS NULL";

/** The pairing's newest displacement: the cursor of the next read; parameters: host id, device id. */
export const DISPLACEMENT_CURSOR_SQL =
  "SELECT detected_at, conflict_id FROM floor_displacements WHERE host_id = ? AND device_id = ? " +
  "ORDER BY detected_at DESC, conflict_id DESC LIMIT 1";

/**
 * The displacements the host sent, each once (by conflict, and by record: a
 * restored host writes a conflict again under a new id). Parameters: host id,
 * device id, the instant, the instant again, the JSON list. One the office
 * reviewed already comes resolved, by nobody of this station.
 */
export const INSERT_DISPLACEMENTS_SQL =
  "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
  "code_hash, box_id, detected_at, winner_shift_number, winner_same_device, winner_scanned_at, " +
  "learned_at, resolved_at, office_reviewed_at) SELECT ?, ?, d.value ->> 'conflictId', " +
  "d.value ->> 'recordId', d.value ->> 'shiftId', d.value ->> 'codeHash', d.value ->> 'boxId', " +
  "d.value ->> 'detectedAt', d.value ->> '$.winner.shiftNumber', " +
  "(d.value ->> '$.winner.sameDevice') = 1, d.value ->> '$.winner.scannedAt', ?, " +
  "CASE WHEN d.value ->> 'reviewedAt' IS NULL THEN NULL ELSE ? END, d.value ->> 'reviewedAt' " +
  "FROM json_each(?) AS d WHERE true ON CONFLICT DO NOTHING";

const idRow = z.object({ id: z.string() });
const cursorRow = z.object({ detected_at: z.string(), conflict_id: z.string() });

export interface NoticeContext {
  local: LocalExecutor;
  pairing: Pairing;
  conflictStatus: HostApi["conflictStatus"];
  listDisplacements: HostApi["listDisplacements"];
  now: () => Date;
}

/** A host that does not know the routes yet (an older build): nothing to learn, no failure. */
function olderHost(error: unknown): boolean {
  return error instanceof HostError && error.kind === "api" && error.code === "not_found";
}

/**
 * What the host tells this station of its conflicts (plan КНФ): first the
 * displacements after the newest one kept, a page at a time, each kept once
 * (one the office reviewed already comes resolved); then, of every record
 * whose conflict or displacement nobody resolved, the ones the office
 * reviewed, in parts of `NOTICE_STATUS_CHUNK` — resolved here with the
 * office's instant and no operator. Each part is one transaction. An older
 * host (`not_found`) is no failure: nothing is learned. Any other failure
 * rejects, and the link retries. Answers whether anything was written, so
 * the status bar and the queue read again.
 */
export async function readConflictNotices(context: NoticeContext): Promise<{ changed: boolean }> {
  const { local, pairing } = context;
  const key = [pairing.hostId, pairing.deviceId];
  let changed = false;
  try {
    for (;;) {
      const [cursor] = await local.query(DISPLACEMENT_CURSOR_SQL, key, cursorRow);
      const page = await context.listDisplacements(
        cursor === undefined ? null : { at: cursor.detected_at, id: cursor.conflict_id },
      );
      if (page.items.length > 0) {
        changed = (await keep(context, page.items)) || changed;
      }
      // A page that says more but holds nothing would ask the same cursor forever.
      if (!page.more || page.items.length === 0) break;
    }
    const open = await local.query(OPEN_NOTICE_IDS_SQL, [...key, ...key], idRow);
    const ids = open.map((row) => row.id).sort();
    for (let start = 0; start < ids.length; start += NOTICE_STATUS_CHUNK) {
      const part = ids.slice(start, start + NOTICE_STATUS_CHUNK);
      const answer = await context.conflictStatus({ recordIds: part });
      const asked = new Set(part);
      const reviewed = answer.reviewed.filter((entry) => asked.has(entry.recordId));
      if (reviewed.length === 0) continue;
      const at = context.now().toISOString();
      const list = JSON.stringify(reviewed);
      await local.transaction([
        { sql: APPLY_REVIEWED_OUTBOX_SQL, values: [at, list, pairing.hostId, pairing.deviceId] },
        {
          sql: APPLY_REVIEWED_DISPLACEMENTS_SQL,
          values: [at, list, pairing.hostId, pairing.deviceId],
        },
      ]);
      changed = true;
    }
  } catch (error) {
    if (olderHost(error)) return { changed };
    throw error;
  }
  return { changed };
}

async function keep(
  context: NoticeContext,
  items: readonly DeviceDisplacement[],
): Promise<boolean> {
  const at = context.now().toISOString();
  const [inserted = 0] = await context.local.transaction([
    {
      sql: INSERT_DISPLACEMENTS_SQL,
      values: [context.pairing.hostId, context.pairing.deviceId, at, at, JSON.stringify(items)],
    },
  ]);
  // A page the station kept already (the same rows sent again) changes nothing.
  return inserted > 0;
}
