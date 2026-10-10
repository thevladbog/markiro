import { boxMembershipDigestV1, buildSscc, DomainError } from "@markiro/domain";
import { z } from "zod";

import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { boxClosedRecord, outboxStatement } from "../facts.js";
import type { ScanContext } from "./scan-pipeline.js";
import { readOpenBox } from "./work-reads.js";

/** The extension digit of a box's SSCC (decision 9; a pallet's is 1, a later plan's). */
export const BOX_EXTENSION = 0;

/** What a box's close needs of the work: the scan pipeline's context without the host. */
export type BoxContext = Pick<
  ScanContext,
  "local" | "pairing" | "shift" | "operatorId" | "now" | "newId"
>;

/** A box on its way to close: everything its `box_closed` record says, before the write. */
export interface ClosingBox {
  boxId: string;
  shiftId: string;
  sscc: string;
  blockId: string;
  serial: number;
  openedAt: string;
  closedAt: string;
  itemCount: number;
  /** The box's codes (`kmHash`), sorted by hash (the order the digest takes). */
  codeHashes: readonly string[];
  operatorId: string;
}

/**
 * What a later plan adds to a box's close, committed in the same transaction
 * after it: plan 2a7 the box's print job, the pallets' plan the box joining
 * the station's open pallet. `data` adds fields to the `box_closed` record
 * (the pallets' plan: `palletId`, which its own change of
 * `boxClosedFactSchema` admits); the record's own fields always win.
 */
export interface CloseAddition {
  statements: readonly LocalStatement[];
  data?: Readonly<Record<string, unknown>>;
}

/**
 * A later plan's part of a close, read before the write (it may query the
 * local database). The extension point of the pallets' plan and plan 2a7: a
 * close with no steps — what `closeOpenBox` and `closeIfFull` do by default,
 * and all it does until those plans pass theirs — adds nothing to the write.
 * A step that throws stops the close with nothing written; a step's statement
 * whose `expectedChanges` does not hold fails the close as `stale`.
 */
export type CloseStep = (box: ClosingBox) => Promise<CloseAddition>;

/**
 * How a close went: `closed`; `empty` — no open box, or one without a code,
 * and no serial spent; `no_serials` — no block of the snapshot's prefix has a
 * serial left; `invalid_serial` — the block's next serial cannot label this
 * box, because it is past what the prefix can number (the domain's
 * `SSCC_RANGE`) or because a box already holds its SSCC (the number is unique
 * across pairings: a forget keeps the boxes of a former one): that serial is
 * spent and the box stays open, so the next close takes the next one rather
 * than fail on this one for good; `stale` — the box or the block changed
 * between the read and the write, nothing was written, and the close may
 * simply be tried again.
 */
export type CloseResult =
  | { kind: "closed"; box: ClosingBox }
  | { kind: "empty" }
  | { kind: "no_serials" }
  | { kind: "invalid_serial" }
  | { kind: "stale" };

const codeRow = z.object({ code_hash: z.string() });

/** The codes of a box, in the order the digest takes them (pinned in both query-plan lists). */
export const BOX_CODES_SQL =
  "SELECT code_hash FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ? " +
  "ORDER BY code_hash";

/** A box of the pairing that is closed, by its key (pinned in both query-plan lists). */
export const CLOSED_BOX_SQL =
  "SELECT shift_id, sscc, block_id, serial, opened_at, closed_at, item_count, closed_by " +
  "FROM floor_boxes WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NOT NULL";

const closedBoxRow = z.object({
  shift_id: z.string(),
  sscc: z.string(),
  block_id: z.string(),
  serial: z.number().int().nonnegative(),
  opened_at: z.string(),
  closed_at: z.string(),
  item_count: z.number().int().nonnegative(),
  closed_by: z.string().nullable(),
});

/**
 * A box of this pairing as its close left it, or `null` when it is not closed
 * (still open, unknown, or another pairing's). The work screen reads the box
 * back when a close ended without an answer: the write may have been
 * committed all the same, and the retry finds no open box to close. Whoever
 * follows a close — plan 2a7's label and its print job — must not be skipped
 * for that, so the box comes back in the shape `closeOpenBox` gives it.
 * `fallbackOperatorId` names the operator for a box whose closer is not
 * recorded.
 */
export async function readClosedBox(
  local: LocalExecutor,
  pairing: Pairing,
  boxId: string,
  fallbackOperatorId: string,
): Promise<ClosingBox | null> {
  const [row] = await local.query(
    CLOSED_BOX_SQL,
    [boxId, pairing.hostId, pairing.deviceId],
    closedBoxRow,
  );
  if (row === undefined) return null;
  const codes = await local.query(
    BOX_CODES_SQL,
    [pairing.hostId, pairing.deviceId, boxId],
    codeRow,
  );
  return {
    boxId,
    shiftId: row.shift_id,
    sscc: row.sscc,
    blockId: row.block_id,
    serial: row.serial,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    itemCount: row.item_count,
    codeHashes: codes.map((code) => code.code_hash),
    operatorId: row.closed_by ?? fallbackOperatorId,
  };
}

const blockRow = z.object({ block_id: z.string(), next_serial: z.number().int().nonnegative() });
const heldRow = z.object({ n: z.literal(1) });

function spendSerial(blockId: string, serial: number): LocalStatement {
  return {
    sql:
      "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
      "WHERE block_id = ? AND next_serial = ?",
    values: [blockId, serial],
    expectedChanges: 1,
  };
}

/** Runs the write; a guard that no longer holds is `stale`, anything else rejects. */
async function commit(
  context: BoxContext,
  statements: readonly LocalStatement[],
): Promise<"done" | "stale"> {
  try {
    await context.local.transaction(statements);
    return "done";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "stale";
    throw error;
  }
}

/** The serial is lost: spent on its own, by the same comparison, and the box stays open. */
async function loseSerial(
  context: BoxContext,
  blockId: string,
  serial: number,
): Promise<CloseResult> {
  const spent = await commit(context, [spendSerial(blockId, serial)]);
  return spent === "stale" ? { kind: "stale" } : { kind: "invalid_serial" };
}

/**
 * Closes the shift's open box (stage 2a spec §5.7.4, decision 10): not an
 * empty one; the next serial of the earliest block of the snapshot's prefix
 * that has one; the SSCC by the domain's `buildSscc`; then ONE transaction —
 * the serial spent by comparing the block's cursor with the value read, the
 * box closed only if it is still open with the same count, its `box_closed`
 * record, and what `steps` add. Either everything is written or nothing: a
 * serial is never spent without its box, and two closes can never take one
 * serial.
 */
export async function closeOpenBox(
  context: BoxContext,
  steps: readonly CloseStep[] = [],
): Promise<CloseResult> {
  const { local, pairing, shift } = context;
  const box = await readOpenBox(local, pairing, shift.copy.id);
  if (box === null || box.itemCount === 0) return { kind: "empty" };
  const codes = await local.query(
    BOX_CODES_SQL,
    [pairing.hostId, pairing.deviceId, box.id],
    codeRow,
  );
  const [block] = await local.query(
    "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
      "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
      "ORDER BY from_serial, block_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, shift.snapshot.issuerPrefix, BOX_EXTENSION],
    blockRow,
  );
  if (block === undefined) return { kind: "no_serials" };
  let sscc: string;
  try {
    sscc = buildSscc(BOX_EXTENSION, shift.snapshot.issuerPrefix, block.next_serial);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "SSCC_RANGE") throw error;
    // As in the cloud: the serial is lost, the box stays open, and the next
    // close takes the next serial instead of failing on this one forever.
    return loseSerial(context, block.block_id, block.next_serial);
  }
  // The SSCC is unique across pairings (`floor_boxes_sscc`): a box of a former
  // pairing may hold it. The write would then fail whole on the key as a
  // generic `statement_failed`, which "Повторить" repeats with the same serial
  // for good; a serial that cannot label a box is lost like one past the range.
  const [held] = await local.query(
    "SELECT 1 AS n FROM floor_boxes WHERE sscc = ? LIMIT 1",
    [sscc],
    heldRow,
  );
  if (held !== undefined) return loseSerial(context, block.block_id, block.next_serial);
  const closing: ClosingBox = {
    boxId: box.id,
    shiftId: shift.copy.id,
    sscc,
    blockId: block.block_id,
    serial: block.next_serial,
    openedAt: box.openedAt,
    closedAt: context.now().toISOString(),
    itemCount: box.itemCount,
    codeHashes: codes.map((row) => row.code_hash),
    operatorId: context.operatorId,
  };
  const additions: CloseAddition[] = [];
  for (const step of steps) additions.push(await step(closing));
  const added: Record<string, unknown> = {};
  for (const addition of additions) Object.assign(added, addition.data);
  const record = boxClosedRecord(
    { id: context.newId(), shiftId: closing.shiftId, operatorId: closing.operatorId },
    {
      ...added,
      boxId: closing.boxId,
      sscc: closing.sscc,
      blockId: closing.blockId,
      serial: closing.serial,
      openedAt: closing.openedAt,
      closedAt: closing.closedAt,
      itemCount: closing.itemCount,
      membershipDigest: boxMembershipDigestV1(closing.codeHashes),
    },
  );
  const written = await commit(context, [
    spendSerial(closing.blockId, closing.serial),
    {
      sql:
        "UPDATE floor_boxes SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, closed_by = ? " +
        "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL AND item_count = ?",
      values: [
        closing.closedAt,
        closing.sscc,
        closing.blockId,
        closing.serial,
        closing.operatorId,
        closing.boxId,
        pairing.hostId,
        pairing.deviceId,
        closing.itemCount,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, pairing, closing.closedAt),
    ...additions.flatMap((addition) => addition.statements),
  ]);
  return written === "stale" ? { kind: "stale" } : { kind: "closed", box: closing };
}

/**
 * Whether a box holding `itemCount` codes is full under the shift's box
 * `capacity`: from the capacity on. The one rule of "full" — `closeIfFull`
 * (a caller outside the screen) and the work screen's close both ask it, so
 * a plan that changes it changes it in one place.
 */
export function boxIsFull(itemCount: number, capacity: number): boolean {
  return itemCount >= capacity;
}

/**
 * Closes the open box once it holds the shift's box capacity (stage 2a spec
 * §5.7.3, step 6): after every accepted scan, and when the work screen opens —
 * a station stopped between the scan that filled a box and its close finds
 * the box full and closes it first. `null` while the box has room.
 */
export async function closeIfFull(
  context: BoxContext,
  steps: readonly CloseStep[] = [],
): Promise<CloseResult | null> {
  const box = await readOpenBox(context.local, context.pairing, context.shift.copy.id);
  if (box === null || !boxIsFull(box.itemCount, context.shift.copy.boxCapacity)) return null;
  return closeOpenBox(context, steps);
}
