import { z } from "zod";

import type { KnownBlocksRequest, KnownBlocksResponse } from "../host/backups.js";
import { HostError } from "../host/client.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";
import { FROM_ZERO_SQL, type Pairing } from "./reference-sync.js";

/** The most blocks one `POST /v1/device/sscc/blocks/known` carries (`known_blocks::MAX_BLOCKS`). */
export const MAX_KNOWN_BLOCKS = 64;

/**
 * How far back a reconciliation sends the acknowledged records again: the
 * station keeps them 30 days (stage 2a, decision 31), so a copy of the host
 * younger than that gets back every record it lost.
 */
export const RESEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The host's answer does not answer the blocks sent: nothing of it is kept, and the run fails. */
export class KnownBlocksMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnownBlocksMismatchError";
  }
}

/**
 * The note of an epoch: a first one or another than the last is new and owes
 * everything again (`reconciled_at`, `refused` and `refused_blocks` start
 * over); the same one changes nothing. Parameters: host id, device id, epoch,
 * the instant seen.
 */
export const NOTE_SQL =
  "INSERT INTO floor_restore_epochs (host_id, device_id, epoch, seen_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT (host_id, device_id) DO UPDATE SET epoch = excluded.epoch, " +
  "seen_at = excluded.seen_at, reconciled_at = NULL, refused = 0, refused_blocks = '[]' " +
  "WHERE floor_restore_epochs.epoch <> excluded.epoch";

/**
 * Notes the host's restore epoch for this pairing (migration `0009`): a new
 * one — the first this pairing sees, or another than the last — makes the
 * pairing owe the host its blocks again, and the outbox waits until
 * `reconcileRestore` settles it. Returns whether the epoch was new.
 */
export async function noteRestoreEpoch(
  local: LocalExecutor,
  pairing: Pairing,
  epoch: string,
  now: Date,
): Promise<boolean> {
  const [changed] = await local.transaction([
    {
      sql: NOTE_SQL,
      values: [pairing.hostId, pairing.deviceId, epoch, now.toISOString()],
    },
  ]);
  return changed === 1;
}

const dueRow = z.object({ epoch: z.string() });

/** The epoch a pairing still owes; parameters: host id, device id. */
export const DUE_SQL =
  "SELECT epoch FROM floor_restore_epochs WHERE host_id = ? AND device_id = ? " +
  "AND reconciled_at IS NULL";

/** Whether this pairing still owes the host its blocks after a restore: the outbox waits meanwhile. */
export async function restoreDue(local: LocalExecutor, pairing: Pairing): Promise<boolean> {
  const due = await local.query(DUE_SQL, [pairing.hostId, pairing.deviceId], dueRow);
  return due.length > 0;
}

/** The status bar's read of the obligation; parameters: host id, device id. */
export const STATUS_SQL =
  "SELECT reconciled_at IS NULL AS due, refused, refused_blocks FROM floor_restore_epochs " +
  "WHERE host_id = ? AND device_id = ?";

/** A block the host refused at the last reconciliation, with the host's code (`block_overlap`, …). */
export interface RefusedBlock {
  id: string;
  code: string | null;
}

const refusedBlocksSchema = z.array(z.object({ id: z.string(), code: z.string().nullable() }));

const statusRow = z.object({
  due: z.number().int(),
  refused: z.number().int().nonnegative(),
  refused_blocks: z.string(),
});

/**
 * What a restore left on the station: whether blocks are owed, how many the
 * host refused (the floor's status bar says it) and which, with its code (for
 * support; nothing shows them yet).
 */
export interface RestoreStatus {
  due: boolean;
  refused: number;
  refusedBlocks: RefusedBlock[];
}

export async function readRestoreStatus(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<RestoreStatus> {
  const [row] = await local.query(STATUS_SQL, [pairing.hostId, pairing.deviceId], statusRow);
  return row === undefined
    ? { due: false, refused: 0, refusedBlocks: [] }
    : {
        due: row.due === 1,
        refused: row.refused,
        refusedBlocks: refusedBlocksSchema.parse(JSON.parse(row.refused_blocks)),
      };
}

const blockRow = z.object({
  block_id: z.string(),
  issuer_prefix: z.string(),
  extension: z.number().int(),
  from_serial: z.number().int(),
  to_serial: z.number().int(),
});

/**
 * Every block this pairing holds, in the order they arrived: the used up
 * ones too, their serials are printed. Parameters: host id, device id.
 */
export const BLOCKS_SQL =
  "SELECT block_id, issuer_prefix, extension, from_serial, to_serial FROM floor_sscc_blocks " +
  "WHERE host_id = ? AND device_id = ? ORDER BY received_at, block_id";

/**
 * No serial of the blocks named is used again: the cursor goes past the end.
 * Parameters: host id, device id, the block ids (a JSON array).
 */
export const RETIRE_SQL =
  "UPDATE floor_sscc_blocks SET next_serial = to_serial + 1 " +
  "WHERE host_id = ? AND device_id = ? AND block_id IN (SELECT value FROM json_each(?))";

function retireStatement(pairing: Pairing, ids: string): LocalStatement {
  return { sql: RETIRE_SQL, values: [pairing.hostId, pairing.deviceId, ids] };
}

/**
 * The records the host acknowledged since an instant: waiting again, as if
 * never sent. A receipt and its outcome come and go together (a CHECK of
 * `outbox`), so `outcome IS NOT NULL` changes no row — it lets the search
 * use the pairing's settled records (`outbox_settled`) instead of reading
 * the whole table. A record a person resolved (plan ОЧ) stays settled: a
 * refusal sent again under a new id would otherwise reach the host twice, and
 * one taken off was meant never to go. Parameters: host id, device id, the
 * instant (as `Date.toISOString` writes `acked_at`).
 */
export const REOPEN_SQL =
  "UPDATE outbox SET outcome = NULL, outcome_code = NULL, outcome_details = NULL, " +
  "acked_at = NULL WHERE host_id = ? AND device_id = ? AND outcome IS NOT NULL AND acked_at >= ? " +
  "AND resolved_at IS NULL";

function reopenStatement(pairing: Pairing, since: string): LocalStatement {
  return { sql: REOPEN_SQL, values: [pairing.hostId, pairing.deviceId, since] };
}

/**
 * Settles the epoch the run read, once: only while it is still that epoch
 * and still owed. Parameters: the instant, the refused count, the refused
 * blocks (a JSON list of `{id, code}`), host id, device id, the epoch.
 */
export const SETTLE_SQL =
  "UPDATE floor_restore_epochs SET reconciled_at = ?, refused = ?, refused_blocks = ? " +
  "WHERE host_id = ? AND device_id = ? AND epoch = ? AND reconciled_at IS NULL";

/** A host that was never restored lost no block (`conflict` on `no_restore`). */
function neverRestored(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.kind === "api" &&
    error.code === "conflict" &&
    error.details["constraint"] === "no_restore"
  );
}

export interface ReconcileContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** `HostApi.registerKnownBlocks`. */
  register: (request: KnownBlocksRequest) => Promise<KnownBlocksResponse>;
  now: () => Date;
}

export type ReconcileResult =
  | { kind: "none" }
  | { kind: "reconciled"; epoch: string; registered: number; known: number; refused: number };

/**
 * What a pairing owes a host restored from a copy (plan РК-С, pilot spec
 * §11), once `noteRestoreEpoch` noted the new epoch:
 *
 * 1. every block it holds goes back, 64 to a request, as the host issued it;
 *    a block the host refuses (`block_overlap`, `block_mismatch`,
 *    `prefix_unknown`, `range_invalid`) is never used again — its cursor goes
 *    past its end in the transaction after that answer — so no box closes
 *    with a serial that may be another device's or that the host will refuse;
 * 2. then, in ONE transaction: the next sync starts from zero
 *    (`FROM_ZERO_SQL`), the records acknowledged in the last 30 days wait to
 *    go again (the host answers a record it has with the receipt it keeps,
 *    and takes one it lost), and the epoch is settled with the count of the
 *    refused blocks — only if it is still the epoch this run read, or a later
 *    restore noted meanwhile fails the batch (`changes_mismatch`) and is
 *    settled by the next run. Which blocks were refused, and the host's code
 *    for each, are kept with it (`readRestoreStatus`).
 *
 * A failed request or write rejects, and the next run sends every block
 * again (the host answers `known` for one it took). A host that says it was
 * never restored owes nothing back. A pairing without blocks sends one empty
 * request: the host marks a station only on a request it answered (plan ХП).
 */
export async function reconcileRestore(context: ReconcileContext): Promise<ReconcileResult> {
  const { local, pairing, register, now } = context;
  const [due] = await local.query(DUE_SQL, [pairing.hostId, pairing.deviceId], dueRow);
  if (due === undefined) return { kind: "none" };
  const blocks = await local.query(BLOCKS_SQL, [pairing.hostId, pairing.deviceId], blockRow);
  let registered = 0;
  let known = 0;
  const refusedBlocks: RefusedBlock[] = [];
  // One request per 64 blocks, and one empty request when the pairing holds none.
  let start = 0;
  do {
    const chunk = blocks.slice(start, start + MAX_KNOWN_BLOCKS);
    let answer: KnownBlocksResponse;
    try {
      answer = await register({
        blocks: chunk.map((block) => ({
          id: block.block_id,
          issuerPrefix: block.issuer_prefix,
          extension: block.extension,
          fromSerial: block.from_serial,
          toSerial: block.to_serial,
        })),
      });
    } catch (error) {
      if (neverRestored(error)) break;
      throw error;
    }
    if (answer.results.length !== chunk.length) {
      throw new KnownBlocksMismatchError(
        `${answer.results.length} results for ${chunk.length} blocks`,
      );
    }
    const refusedHere: RefusedBlock[] = [];
    chunk.forEach((block, index) => {
      const result = answer.results[index];
      if (result === undefined || result.id !== block.block_id) {
        throw new KnownBlocksMismatchError(`result ${index} names another block`);
      }
      if (result.outcome === "registered") registered += 1;
      else if (result.outcome === "known") known += 1;
      else refusedHere.push({ id: block.block_id, code: result.code });
    });
    if (refusedHere.length > 0) {
      const ids = JSON.stringify(refusedHere.map((block) => block.id));
      await local.transaction([retireStatement(pairing, ids)]);
      refusedBlocks.push(...refusedHere);
    }
    start += MAX_KNOWN_BLOCKS;
  } while (start < blocks.length);
  const refused = refusedBlocks.length;
  const at = now();
  await local.transaction([
    { sql: FROM_ZERO_SQL, values: [due.epoch] },
    reopenStatement(pairing, new Date(at.getTime() - RESEND_WINDOW_MS).toISOString()),
    {
      sql: SETTLE_SQL,
      values: [
        at.toISOString(),
        refused,
        JSON.stringify(refusedBlocks),
        pairing.hostId,
        pairing.deviceId,
        due.epoch,
      ],
      expectedChanges: 1,
    },
  ]);
  return { kind: "reconciled", epoch: due.epoch, registered, known, refused };
}
