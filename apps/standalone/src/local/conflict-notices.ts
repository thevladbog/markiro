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

/**
 * The same for displacements; parameters as `APPLY_REVIEWED_OUTBOX_SQL`. The
 * planner walks the pairing's open displacements (their partial index) and
 * matches each against the list: both are few.
 */
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
 * The displacements the host sent, each once. The same conflict again changes
 * nothing; the same record under a new conflict (a restored host writes it
 * again under a new id and a later instant) keeps its row and its
 * resolution and only moves to the newer conflict, so the cursor of the next
 * read moves on. The shift's number and the box's SSCC are a snapshot taken
 * once, when the row is first written (the host's SSCC, or this station's of
 * a box the host still had open), and never again: the row stays readable
 * after the retention deleted the shift's copy and its boxes. One the office reviewed already comes resolved, by nobody of
 * this station. Parameters: host id, device id, the instant, the instant
 * again, the JSON list.
 */
export const INSERT_DISPLACEMENTS_SQL =
  "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
  "code_hash, box_id, detected_at, winner_shift_number, winner_same_device, winner_scanned_at, " +
  "learned_at, resolved_at, office_reviewed_at, shift_number, box_sscc) " +
  "SELECT ?, ?, j.value ->> 'conflictId', " +
  "j.value ->> 'recordId', j.value ->> 'shiftId', j.value ->> 'codeHash', j.value ->> 'boxId', " +
  "j.value ->> 'detectedAt', j.value ->> '$.winner.shiftNumber', " +
  "(j.value ->> '$.winner.sameDevice') = 1, j.value ->> '$.winner.scannedAt', ?, " +
  "CASE WHEN j.value ->> 'reviewedAt' IS NULL THEN NULL ELSE ? END, j.value ->> 'reviewedAt', " +
  "j.value ->> 'shiftNumber', coalesce(j.value ->> 'boxSscc', " +
  "(SELECT b.sscc FROM floor_boxes b WHERE b.id = j.value ->> 'boxId')) " +
  "FROM json_each(?) AS j WHERE true " +
  "ON CONFLICT (host_id, device_id, conflict_id) DO NOTHING " +
  "ON CONFLICT (host_id, device_id, record_id) DO UPDATE SET conflict_id = excluded.conflict_id, " +
  "detected_at = excluded.detected_at WHERE excluded.detected_at > floor_displacements.detected_at";

/**
 * The first id of all: a read starts at the beginning of the newest second it
 * keeps. The host stamps a conflict in whole seconds and names it by a random
 * id, so a conflict committed later in that second may sort before the
 * newest one kept; reading the whole second again (each row is kept once)
 * never skips it.
 */
export const SECOND_START_ID = "00000000-0000-0000-0000-000000000000";

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
 * displacements from the newest second kept on, a page at a time, each kept once
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
    const [newest] = await local.query(DISPLACEMENT_CURSOR_SQL, key, cursorRow);
    let after: { at: string; id: string } | null =
      newest === undefined ? null : { at: newest.detected_at, id: SECOND_START_ID };
    for (;;) {
      const page = await context.listDisplacements(after);
      const last = page.items.at(-1);
      if (last !== undefined) {
        changed = (await keep(context, page.items)) || changed;
        // The next page follows this one's last row, whatever the station kept of it.
        after = { at: last.detectedAt, id: last.conflictId };
      }
      // A page that says more but holds nothing would ask the same cursor forever.
      if (!page.more || last === undefined) break;
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
      const [records = 0, displacements = 0] = await local.transaction([
        { sql: APPLY_REVIEWED_OUTBOX_SQL, values: [at, list, pairing.hostId, pairing.deviceId] },
        {
          sql: APPLY_REVIEWED_DISPLACEMENTS_SQL,
          values: [at, list, pairing.hostId, pairing.deviceId],
        },
      ]);
      // A record a person resolved meanwhile is left as they resolved it.
      changed = records + displacements > 0 || changed;
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
