import { z } from "zod";

import { factRecordSchema } from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/**
 * The most refused records one transaction carries again. A record is at most
 * 16 KiB (`MAX_RECORD_BYTES`), so a part's payloads stay under a megabyte; the
 * JSON list that carries them escapes each payload once more (up to about
 * twice its size) and is bound twice, by the insert and by the mark. The shell
 * bounds the SQL text (`MAX_SQL_BYTES`) and the number of values, not the size
 * of one, so the part's size costs memory and the transaction's length only.
 */
export const RESEND_CHUNK = 50;

/** What waits for the host, by kind, with the oldest record of each; parameters: host id, device id. */
export const QUEUE_UNSENT_SQL =
  "SELECT kind, count(*) AS n, min(created_at) AS oldest FROM outbox " +
  "WHERE host_id = ? AND device_id = ? AND acked_at IS NULL GROUP BY kind";

/**
 * The most refused records, and the most conflicts, of one shift the queue
 * screen lists; the rest it counts (`QUEUE_TALLY_SQL`). After a restore of the
 * host a shift the copy does not know is refused on every record — thousands —
 * and the screen reads again on every batch of receipts.
 */
export const QUEUE_LISTED_PER_SHIFT = 20;

/**
 * The first refused and the first conflicting records nobody resolved yet of
 * each shift, at most the bound given of each, in the order they were kept,
 * with the number of their shift and the SSCC of the box or pallet they name
 * (never a code of marking); parameters: host id, device id, the bound. Only
 * the records listed are joined and their payloads read; sorted by `seq` in
 * memory.
 */
export const QUEUE_SETTLED_SQL =
  "SELECT o.id, o.seq, o.kind, o.shift_id, s.number AS shift_number, o.created_at, o.outcome, " +
  "o.outcome_code AS code, coalesce(o.payload ->> '$.data.sscc', b.sscc, p.sscc) AS sscc " +
  "FROM (SELECT seq, row_number() OVER (PARTITION BY shift_id, outcome ORDER BY seq) AS place " +
  "FROM outbox WHERE host_id = ? AND device_id = ? AND outcome IN ('rejected', 'conflict') " +
  "AND resolved_at IS NULL) AS f JOIN outbox o ON o.seq = f.seq " +
  "LEFT JOIN floor_shifts s ON s.host_id = o.host_id " +
  "AND s.device_id = o.device_id AND s.id = o.shift_id " +
  "LEFT JOIN floor_boxes b ON b.id = (o.payload ->> '$.data.boxId') " +
  "LEFT JOIN floor_pallets p ON p.id = (o.payload ->> '$.data.palletId') " +
  "WHERE f.place <= ?";

/**
 * How many refused and conflicting records nobody resolved each shift holds,
 * by kind — all of them, also the ones the list leaves out; parameters: host
 * id, device id.
 */
export const QUEUE_TALLY_SQL =
  "SELECT shift_id, outcome, kind, count(*) AS n FROM outbox WHERE host_id = ? " +
  "AND device_id = ? AND outcome IN ('rejected', 'conflict') AND resolved_at IS NULL " +
  "GROUP BY shift_id, outcome, kind";

/** A shift's refused records nobody resolved, in the order they were kept; parameters: host id, device id, shift id. */
export const RESEND_READ_SQL =
  "SELECT id, payload FROM outbox WHERE host_id = ? AND device_id = ? AND shift_id = ? " +
  "AND outcome = 'rejected' AND resolved_at IS NULL ORDER BY seq";

/**
 * The refused records again under new ids — a JSON list of `{oldId, newId,
 * payload}` — after everything kept so far, in their order, each with its own
 * kind and shift. A record sent again after its shift's close is late by
 * definition and is written past `outboxStatement`'s check (plan 2a8,
 * «Контракт для ПЛ-Ц и ОЧ»). Parameters: the instant, the list, host id,
 * device id.
 */
export const RESEND_INSERT_SQL =
  "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
  "SELECT r.value ->> 'newId', o.host_id, o.device_id, o.kind, o.shift_id, " +
  "r.value ->> 'payload', ? FROM json_each(?) AS r JOIN outbox AS o ON o.id = r.value ->> 'oldId' " +
  "WHERE +o.host_id = ? AND +o.device_id = ? AND +o.outcome = 'rejected' " +
  "AND o.resolved_at IS NULL ORDER BY o.seq";

/** The refused records marked as sent again; parameters: the instant, the operator, the list, host id, device id. */
export const RESEND_MARK_SQL =
  "UPDATE outbox SET resolution = 'resent', resent_as = r.value ->> 'newId', resolved_at = ?, " +
  "resolved_by = ? FROM json_each(?) AS r WHERE outbox.id = r.value ->> 'oldId' " +
  "AND +outbox.host_id = ? AND +outbox.device_id = ? AND +outbox.outcome = 'rejected' " +
  "AND outbox.resolved_at IS NULL";

/**
 * A refused or conflicting record taken off the queue by a person — never a
 * shift's close, which only goes again; parameters: the instant, the operator,
 * host id, device id, record id.
 */
export const DISMISS_SQL =
  "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? " +
  "WHERE host_id = ? AND device_id = ? AND id = ? AND outcome IN ('rejected', 'conflict') " +
  "AND kind <> 'shift_closed' AND resolved_at IS NULL";

/**
 * Every refused record of one shift taken off the queue at once by a person —
 * never its close, which only goes again, and never a conflict; parameters:
 * the instant, the operator, host id, device id, shift id.
 */
export const DISMISS_SHIFT_SQL =
  "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ? AND outcome = 'rejected' " +
  "AND kind <> 'shift_closed' AND resolved_at IS NULL";

/**
 * The records other pairings of this computer left without a receipt (a forget
 * with «Сбросить всё равно», a re-pair): they never go, and stay on disk for
 * support. Parameters: host id, device id. `INDEXED BY`: since migration 0010 the
 * planner walks `outbox_shift` (the whole table, covering) instead of the
 * partial index of the unsent records; this walk must stay as long as the
 * unsent ones are few.
 */
export const STRANDED_COUNT_SQL =
  "SELECT count(*) AS n FROM outbox INDEXED BY outbox_unsent WHERE acked_at IS NULL " +
  "AND NOT (host_id = ? AND device_id = ?)";

/**
 * The pairing's displaced scans nobody resolved (plan КНФ: the host had
 * accepted them, then an earlier scan elsewhere took the code), oldest first,
 * with their shift's number and their box's SSCC — the row's own snapshot, so
 * they outlive the shift's copy; the live copy only fills a snapshot that
 * had none; at most 100. Parameters:
 * host id, device id.
 */
export const QUEUE_DISPLACED_SQL =
  "SELECT d.conflict_id, d.shift_id, coalesce(d.shift_number, s.number) AS shift_number, " +
  "coalesce(d.box_sscc, b.sscc) AS sscc, d.box_id, d.detected_at, " +
  "d.winner_shift_number, d.winner_same_device FROM floor_displacements d " +
  "LEFT JOIN floor_shifts s ON s.host_id = d.host_id AND s.device_id = d.device_id " +
  "AND s.id = d.shift_id LEFT JOIN floor_boxes b ON b.id = d.box_id " +
  "WHERE d.host_id = ? AND d.device_id = ? AND d.resolved_at IS NULL " +
  "ORDER BY d.detected_at, d.conflict_id LIMIT 100";

/** A displacement settled by a person; parameters: the instant, the operator, host id, device id, conflict id. */
export const DISMISS_DISPLACEMENT_SQL =
  "UPDATE floor_displacements SET resolved_at = ?, resolved_by = ? WHERE host_id = ? " +
  "AND device_id = ? AND conflict_id = ? AND resolved_at IS NULL";

/** The queue changed under the person's decision: nothing was written, the screen reads again. */
export class StaleQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleQueueError";
  }
}

/** A refused record this build cannot carry again unchanged: it can only be taken off. */
export class UnreadableRecordError extends Error {
  readonly recordId: string;

  constructor(recordId: string) {
    super(`record ${recordId} cannot be carried again by this build`);
    this.name = "UnreadableRecordError";
    this.recordId = recordId;
  }
}

export interface UnsentKind {
  kind: string;
  count: number;
  /** The oldest record's `created_at`. */
  oldest: string;
}

export interface SettledRecord {
  id: string;
  seq: number;
  kind: string;
  shiftId: string;
  /** `null` when this pairing keeps no copy of the shift. */
  shiftNumber: string | null;
  createdAt: string;
  outcome: "rejected" | "conflict";
  /** The host's code of a refusal; `null` for a conflict or a refusal without one. */
  code: string | null;
  /** The SSCC of the box or pallet the record names, when the station knows it. */
  sscc: string | null;
}

/** How many unresolved records of one outcome and kind a shift holds. */
export interface SettledTally {
  shiftId: string;
  outcome: "rejected" | "conflict";
  kind: string;
  count: number;
}

/** A displaced scan of this station (plan КНФ), as the queue screen shows it. */
export interface DisplacedRecord {
  conflictId: string;
  shiftId: string;
  shiftNumber: string | null;
  /** The SSCC of the box the code left; `null` while it is open or unknown here. */
  sscc: string | null;
  /** `false` for a validation shift's scan (plan РЕЖ): it names no box, so there is none to check. */
  boxed: boolean;
  /** The host's instant. */
  detectedAt: string;
  winnerShiftNumber: string;
  /** The earlier scan was this station's own (in another shift, or after a forget). */
  winnerSameDevice: boolean;
}

export interface QueueView {
  unsent: UnsentKind[];
  /** At most `QUEUE_LISTED_PER_SHIFT` refused and as many conflicting records of each shift. */
  settled: SettledRecord[];
  /** Every unresolved refused and conflicting record, counted by shift, outcome and kind. */
  tallies: SettledTally[];
  stranded: number;
  /** The open displacements, at most 100 (plan КНФ). */
  displaced: DisplacedRecord[];
}

/** What a person's decision needs: the operator who makes it, new ids and the clock. */
export interface RecoveryContext {
  local: LocalExecutor;
  pairing: Pairing;
  operatorId: string;
  newId: () => string;
  now: () => Date;
}

const unsentRow = z.object({
  kind: z.string(),
  n: z.number().int().positive(),
  oldest: z.string(),
});
const settledRow = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: z.string(),
  shift_id: z.string(),
  shift_number: z.string().nullable(),
  created_at: z.string(),
  outcome: z.enum(["rejected", "conflict"]),
  code: z.string().nullable(),
  sscc: z.string().nullable(),
});
const displacedRow = z.object({
  conflict_id: z.string(),
  shift_id: z.string(),
  shift_number: z.string().nullable(),
  sscc: z.string().nullable(),
  box_id: z.string().nullable(),
  detected_at: z.string(),
  winner_shift_number: z.string(),
  winner_same_device: z.number().int(),
});
const tallyRow = z.object({
  shift_id: z.string(),
  outcome: z.enum(["rejected", "conflict"]),
  kind: z.string(),
  n: z.number().int().positive(),
});
const payloadRow = z.object({ id: z.string(), payload: z.string() });
const countRow = z.object({ n: z.number().int().nonnegative() });

/** The records other pairings of this computer left without a receipt. */
export async function readStrandedRecords(local: LocalExecutor, pairing: Pairing): Promise<number> {
  const [row] = await local.query(STRANDED_COUNT_SQL, [pairing.hostId, pairing.deviceId], countRow);
  return row?.n ?? 0;
}

/**
 * What the queue screen shows (pilot spec §9.3, plan ОЧ): this pairing's
 * records waiting for the host by kind, oldest kind first; the first refused
 * and conflicting records nobody resolved of each shift
 * (`QUEUE_LISTED_PER_SHIFT` of each), in the order they were kept, and how many
 * there are of each kind; and the records older pairings left unsent. The reads
 * are separate statements: a receipt between them can make a count differ from
 * the list, and a decision taken on a count that no longer holds is a
 * `StaleQueueError`. A failed read rejects.
 */
export async function readQueue(local: LocalExecutor, pairing: Pairing): Promise<QueueView> {
  const key = [pairing.hostId, pairing.deviceId];
  const [unsent, settled, tallies, stranded, displaced] = await Promise.all([
    local.query(QUEUE_UNSENT_SQL, key, unsentRow),
    local.query(QUEUE_SETTLED_SQL, [...key, QUEUE_LISTED_PER_SHIFT], settledRow),
    local.query(QUEUE_TALLY_SQL, key, tallyRow),
    readStrandedRecords(local, pairing),
    local.query(QUEUE_DISPLACED_SQL, key, displacedRow),
  ]);
  return {
    unsent: unsent
      .map((row) => ({ kind: row.kind, count: row.n, oldest: row.oldest }))
      .sort((a, b) => a.oldest.localeCompare(b.oldest) || a.kind.localeCompare(b.kind)),
    settled: settled
      .map((row) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        shiftId: row.shift_id,
        shiftNumber: row.shift_number,
        createdAt: row.created_at,
        outcome: row.outcome,
        code: row.code,
        sscc: row.sscc,
      }))
      .sort((a, b) => a.seq - b.seq),
    tallies: tallies.map((row) => ({
      shiftId: row.shift_id,
      outcome: row.outcome,
      kind: row.kind,
      count: row.n,
    })),
    stranded,
    displaced: displaced.map((row) => ({
      conflictId: row.conflict_id,
      shiftId: row.shift_id,
      shiftNumber: row.shift_number,
      sscc: row.sscc,
      boxed: row.box_id !== null,
      detectedAt: row.detected_at,
      winnerShiftNumber: row.winner_shift_number,
      winnerSameDevice: row.winner_same_device === 1,
    })),
  };
}

/**
 * The record's payload under `newId`, every other byte as kept: the record must
 * read as this build's, and its `data` must come back exactly as stored (the
 * host matches an exception by its instants, plan 2a2), or it cannot go again.
 */
function carried(row: { id: string; payload: string }, newId: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch {
    throw new UnreadableRecordError(row.id);
  }
  const parsed = factRecordSchema.safeParse(raw);
  if (!parsed.success || typeof raw !== "object" || raw === null || !("data" in raw)) {
    throw new UnreadableRecordError(row.id);
  }
  if (JSON.stringify(parsed.data.data) !== JSON.stringify(raw.data)) {
    throw new UnreadableRecordError(row.id);
  }
  return JSON.stringify({ ...parsed.data, id: newId });
}

/**
 * «Отправить снова» (plan ОЧ; plan 2a2, the owner's decision 1): every refused
 * record of the shift nobody resolved goes again under a new id, its data byte
 * for byte, after everything kept so far and in the order it was kept — so a
 * refused record's refused dependents follow it. Each old record is marked
 * `resent` with the id that carries it, the operator and the time, in the
 * transaction that writes the new one; parts of `RESEND_CHUNK` keep the order
 * whatever happens to a later part. A refused close goes the same way; once the
 * host takes it, the receipt makes the shift `closed` (plan 2a8). Every record
 * is read before anything is written: one this build cannot carry rejects the
 * whole shift (`UnreadableRecordError`). A record resolved meanwhile, or none
 * left to send, is a `StaleQueueError`. Returns how many records went again.
 */
export async function resendRefused(context: RecoveryContext, shiftId: string): Promise<number> {
  const { local, pairing } = context;
  const refused = await local.query(
    RESEND_READ_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    payloadRow,
  );
  if (refused.length === 0) throw new StaleQueueError("no refused record of the shift waits");
  const list = refused.map((row) => {
    const newId = context.newId();
    return { oldId: row.id, newId, payload: carried(row, newId) };
  });
  for (let start = 0; start < list.length; start += RESEND_CHUNK) {
    const part = list.slice(start, start + RESEND_CHUNK);
    const at = context.now().toISOString();
    const json = JSON.stringify(part);
    try {
      await local.transaction([
        {
          sql: RESEND_INSERT_SQL,
          values: [at, json, pairing.hostId, pairing.deviceId],
          expectedChanges: part.length,
        },
        {
          sql: RESEND_MARK_SQL,
          values: [at, context.operatorId, json, pairing.hostId, pairing.deviceId],
          expectedChanges: part.length,
        },
      ]);
    } catch (error) {
      if (error instanceof LocalDbError && error.code === "changes_mismatch") {
        throw new StaleQueueError("a refused record of the shift changed meanwhile");
      }
      throw error;
    }
  }
  return list.length;
}

/**
 * «Снять с очереди» / «Разобрано» (plan ОЧ): a refused record — never a
 * shift's close — or a conflict is taken off by a person, with who and when; it
 * is never sent, and the retention may take its shift. A record resolved
 * meanwhile, or a close, is a `StaleQueueError`.
 */
export async function dismissRecord(context: RecoveryContext, recordId: string): Promise<void> {
  const { local, pairing } = context;
  try {
    await local.transaction([
      {
        sql: DISMISS_SQL,
        values: [
          context.now().toISOString(),
          context.operatorId,
          pairing.hostId,
          pairing.deviceId,
          recordId,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleQueueError("the record is resolved already, or a close");
    }
    throw error;
  }
}

/**
 * «Разобрано» on a displaced scan (plan КНФ): a person settled it, with who
 * and when; it stays on this computer. Nothing reaches the host. One the
 * office or a person resolved meanwhile is a `StaleQueueError`.
 */
export async function dismissDisplacement(
  context: RecoveryContext,
  conflictId: string,
): Promise<void> {
  const { local, pairing } = context;
  try {
    await local.transaction([
      {
        sql: DISMISS_DISPLACEMENT_SQL,
        values: [
          context.now().toISOString(),
          context.operatorId,
          pairing.hostId,
          pairing.deviceId,
          conflictId,
        ],
        expectedChanges: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleQueueError("the displacement is resolved already");
    }
    throw error;
  }
}

/**
 * «Снять с очереди все отказы смены» (plan ОЧ, after a restore of the host):
 * every unresolved refused record of the shift — never its close, never a
 * conflict, never another pairing's — is marked `dismissed` with who and when
 * in one statement, so a shift the restored host does not know is not taken
 * off record by record. `expected` is the number the person confirmed: any
 * other number of records (a refusal that arrived since, one resolved
 * meanwhile), or none at all, writes nothing and is a `StaleQueueError`. A
 * refused close stays: it only goes again (О3).
 */
export async function dismissShiftRefusals(
  context: RecoveryContext,
  shiftId: string,
  expected: number,
): Promise<void> {
  if (expected < 1) {
    throw new StaleQueueError("no refused record of the shift to take off");
  }
  const { local, pairing } = context;
  try {
    await local.transaction([
      {
        sql: DISMISS_SHIFT_SQL,
        values: [
          context.now().toISOString(),
          context.operatorId,
          pairing.hostId,
          pairing.deviceId,
          shiftId,
        ],
        expectedChanges: expected,
      },
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleQueueError("the shift's refusals changed meanwhile");
    }
    throw error;
  }
}
