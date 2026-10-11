import { buildSscc, DomainError } from "@markiro/domain";
import { z } from "zod";

import { LocalDbError, type LocalExecutor, type LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, palletClosedRecord } from "../facts.js";
import { palletLabelData } from "../print/label-render.js";
import { prepareLabelJob, type RenderLabel } from "../print/print-jobs.js";
import { readWorkstationSettings } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import type { SnapshotTemplate } from "../shifts/shift-snapshot.js";
import type { BoxContext, CloseStep, ClosingBox } from "../work/box-close.js";

/** The extension digit of a pallet's SSCC (decision 9; a box's is 0). */
export const PALLET_EXTENSION = 1;

/** What a shift with pallets has of them: boxes per pallet and the snapshot's pallet layout. */
export interface ShiftPallets {
  capacity: number;
  template: SnapshotTemplate;
}

/**
 * The pallets of a shift the station works with pallets (plan ПЛ-Ц): its
 * copy's boxes per pallet and its snapshot's pallet layout; `null` for a
 * shift without pallets.
 */
export function shiftPallets(shift: WorkShift): ShiftPallets | null {
  const capacity = shift.copy.palletBoxCapacity;
  const template = shift.snapshot.palletTemplate;
  if (!shift.copy.palletsEnabled || capacity === null || template === null) return null;
  return { capacity, template };
}

/** The open pallet of a shift (one at most): the boxes that close join it. */
export interface OpenPallet {
  id: string;
  openedAt: string;
  /** Its boxes not taken apart: what it holds now. */
  boxCount: number;
  /** The units in those boxes: the `qty` of its label. */
  itemCount: number;
}

/**
 * The boxes of the pallet `p` that are not taken apart, and their units, as
 * SQL: never stored, always counted (the cloud's derived count).
 */
export const LIVE_BOXES =
  "FROM floor_boxes b WHERE b.host_id = p.host_id AND b.device_id = p.device_id " +
  "AND b.pallet_id = p.id AND b.disassembled_at IS NULL";

/**
 * The reading of `readOpenPallet`; parameters: host id, device id, shift id.
 * It runs on every box close and every render of the work screen, so its plan
 * is pinned in both lists of plans (`floor_pallets_open`, and
 * `floor_boxes_pallet` for the two counts).
 */
export const OPEN_PALLET_SQL =
  `SELECT p.id, p.opened_at, (SELECT count(*) ${LIVE_BOXES}) AS boxes, ` +
  `(SELECT coalesce(sum(b.item_count), 0) ${LIVE_BOXES}) AS items FROM floor_pallets p ` +
  "WHERE p.host_id = ? AND p.device_id = ? AND p.shift_id = ? AND p.closed_at IS NULL";

const openRow = z.object({
  id: z.string(),
  opened_at: z.string(),
  boxes: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
});

/** This pairing's open pallet of the shift with what it holds, or `null`. */
export async function readOpenPallet(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<OpenPallet | null> {
  const [row] = await local.query(
    OPEN_PALLET_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    openRow,
  );
  return row === undefined
    ? null
    : { id: row.id, openedAt: row.opened_at, boxCount: row.boxes, itemCount: row.items };
}

/**
 * The comparison that keeps a record from following a disassembly (pinned in
 * both lists of query plans): a no-op update that counts a row only while
 * the pallet is closed and not taken apart. In the transaction of every
 * reprint, so a disassembly that landed between the read and the write makes
 * it `stale` and the host is never sent a `pallet_exception` it must refuse.
 */
export const PALLET_LIVE_GUARD_SQL =
  "UPDATE floor_pallets SET disassembled_at = disassembled_at WHERE id = ? AND host_id = ? " +
  "AND device_id = ? AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL";

/** The guard of a reprint of the pallet `palletId` of the shift `shiftId`. */
export function palletLiveGuard(
  pairing: Pairing,
  shiftId: string,
  palletId: string,
): LocalStatement {
  return {
    sql: PALLET_LIVE_GUARD_SQL,
    values: [palletId, pairing.hostId, pairing.deviceId, shiftId],
    expectedChanges: 1,
  };
}

/** What a pallet's close needs: a box's context, the operator's name for the label, a render. */
export type PalletContext = BoxContext & {
  operatorName: string | null;
  /** How the label is rendered; the app's rasterizer by default. */
  render?: RenderLabel;
};

/** A pallet on its way to close: everything its `pallet_closed` record and its label say. */
export interface ClosingPallet {
  palletId: string;
  shiftId: string;
  sscc: string;
  blockId: string;
  serial: number;
  openedAt: string;
  closedAt: string;
  boxCount: number;
  itemCount: number;
  operatorId: string;
}

/**
 * How a pallet's close went: `closed`; `empty` — no open pallet, or one
 * without a box, and no serial spent; `no_serials` — no pallet block of the
 * snapshot's prefix has a serial left, and the pallet stays open; an SSCC
 * past the prefix's range or already held by another pallet
 * (`invalid_serial`) — that serial is spent and the pallet stays open; `stale` — the pallet or the block changed between the
 * read and the write, nothing was written.
 */
export type PalletCloseResult =
  | { kind: "closed"; pallet: ClosingPallet }
  | { kind: "empty" }
  | { kind: "no_serials" }
  | { kind: "invalid_serial" }
  | { kind: "stale" };

const blockRow = z.object({ block_id: z.string(), next_serial: z.number().int().nonnegative() });
const heldRow = z.object({ n: z.literal(1) });

/** The next serial of the earliest pallet block of the prefix that has one, or `null`. */
async function nextPalletSerial(
  context: BoxContext,
): Promise<{ blockId: string; serial: number } | null> {
  const { local, pairing, shift } = context;
  const [block] = await local.query(
    "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
      "AND issuer_prefix = ? AND extension = ? AND next_serial <= to_serial " +
      "ORDER BY from_serial, block_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, shift.snapshot.issuerPrefix, PALLET_EXTENSION],
    blockRow,
  );
  return block === undefined ? null : { blockId: block.block_id, serial: block.next_serial };
}

function spendSerial(blockId: string, serial: number): LocalStatement {
  return {
    sql:
      "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 " +
      "WHERE block_id = ? AND next_serial = ?",
    values: [blockId, serial],
    expectedChanges: 1,
  };
}

/**
 * Whether a pallet already holds an SSCC (pinned in both lists of plans):
 * `floor_pallets_sscc` is unique across pairings, and a forget keeps a former
 * pairing's pallets.
 */
export const PALLET_SSCC_HELD_SQL = "SELECT 1 AS n FROM floor_pallets WHERE sscc = ? LIMIT 1";

/**
 * The SSCC a pallet can carry for `serial`, by the domain's `buildSscc`;
 * `null` for a serial that cannot label a pallet: past the prefix's range, or
 * whose SSCC another pallet already holds (after a host reinstalled with its
 * counter reset). The write would fail whole on the unique key as a generic
 * `statement_failed`, which every box close and every retry would repeat with
 * the same serial for good; the box close loses such a serial instead.
 */
async function freePalletSscc(
  local: LocalExecutor,
  issuerPrefix: string,
  serial: number,
): Promise<string | null> {
  let sscc: string;
  try {
    sscc = buildSscc(PALLET_EXTENSION, issuerPrefix, serial);
  } catch (error) {
    if (error instanceof DomainError && error.code === "SSCC_RANGE") return null;
    throw error;
  }
  const [held] = await local.query(PALLET_SSCC_HELD_SQL, [sscc], heldRow);
  return held === undefined ? sscc : null;
}

/**
 * The close of a pallet by its key (the values in the order `closeStatements`
 * gives them), only while it is open and holds the boxes counted; pinned in
 * both lists of plans.
 */
export const CLOSE_PALLET_SQL =
  "UPDATE floor_pallets AS p SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, " +
  "closed_by = ? WHERE p.id = ? AND p.host_id = ? AND p.device_id = ? " +
  `AND p.closed_at IS NULL AND (SELECT count(*) ${LIVE_BOXES}) = ?`;

/**
 * The statements that close `pallet`, for the transaction that writes them
 * (pilot spec §6.2): the serial spent by comparing the block's cursor with
 * the value read; the pallet closed only while it is open and holds the
 * boxes counted (a box that joined or was taken apart meanwhile makes the
 * whole transaction `stale`); its `pallet_closed` record; and its print job,
 * rendered from the snapshot's pallet layout for the printer of the purpose
 * «Паллета» — no printer, or no render, keeps the job `failed`, and the
 * pallet closes all the same.
 */
async function closeStatements(
  context: PalletContext,
  pallets: ShiftPallets,
  pallet: ClosingPallet,
): Promise<LocalStatement[]> {
  const { pairing, shift } = context;
  const record = palletClosedRecord(
    { id: context.newId(), shiftId: pallet.shiftId, operatorId: pallet.operatorId },
    {
      palletId: pallet.palletId,
      sscc: pallet.sscc,
      blockId: pallet.blockId,
      serial: pallet.serial,
      openedAt: pallet.openedAt,
      closedAt: pallet.closedAt,
      boxCount: pallet.boxCount,
    },
  );
  const settings = await readWorkstationSettings(context.local);
  const job = await prepareLabelJob(
    {
      id: context.newId(),
      shiftId: pallet.shiftId,
      purpose: "pallet",
      subjectId: pallet.palletId,
      sscc: pallet.sscc,
      fields: palletLabelData(shift, pallet, context.operatorName),
      template: pallets.template,
      operatorId: pallet.operatorId,
      createdAt: pallet.closedAt,
    },
    settings,
    pairing,
    context.render,
  );
  return [
    spendSerial(pallet.blockId, pallet.serial),
    {
      sql: CLOSE_PALLET_SQL,
      values: [
        pallet.closedAt,
        pallet.sscc,
        pallet.blockId,
        pallet.serial,
        pallet.operatorId,
        pallet.palletId,
        pairing.hostId,
        pairing.deviceId,
        pallet.boxCount,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, pairing, pallet.closedAt),
    job,
  ];
}

/** Runs the write; a guard that no longer holds is `stale`, anything else rejects. */
async function commit(
  local: LocalExecutor,
  statements: readonly LocalStatement[],
): Promise<"done" | "stale"> {
  try {
    await local.transaction(statements);
    return "done";
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") return "stale";
    throw error;
  }
}

/**
 * Closes the shift's open pallet (pilot spec §6.1–6.2, the cloud's
 * `closeCurrentPallet`): «Закрыть паллету досрочно», «Закрыть паллету и
 * смену», or a full pallet that waited for serials. Never an empty one: an
 * open pallet with no box left is refused before a serial is spent. The next
 * serial of the earliest pallet block of the snapshot's prefix, the SSCC by
 * the domain's `buildSscc(1, …)`, then ONE transaction — the serial, the
 * pallet with the boxes counted, its record and its label's job. No serial —
 * the pallet stays open (the next boxes join it) and the shift's close waits.
 */
export async function closeOpenPallet(
  context: PalletContext,
  pallets: ShiftPallets,
): Promise<PalletCloseResult> {
  const { local, pairing, shift } = context;
  const open = await readOpenPallet(local, pairing, shift.copy.id);
  if (open === null || open.boxCount === 0) return { kind: "empty" };
  const next = await nextPalletSerial(context);
  if (next === null) return { kind: "no_serials" };
  const sscc = await freePalletSscc(local, shift.snapshot.issuerPrefix, next.serial);
  if (sscc === null) {
    // As for a box: the serial is lost (past the range, or its SSCC held), the
    // pallet stays open, and the next close takes the next serial instead of
    // failing on this one forever.
    const spent = await commit(local, [spendSerial(next.blockId, next.serial)]);
    return spent === "stale" ? { kind: "stale" } : { kind: "invalid_serial" };
  }
  const pallet: ClosingPallet = {
    palletId: open.id,
    shiftId: shift.copy.id,
    sscc,
    blockId: next.blockId,
    serial: next.serial,
    openedAt: open.openedAt,
    closedAt: context.now().toISOString(),
    boxCount: open.boxCount,
    itemCount: open.itemCount,
    operatorId: context.operatorId,
  };
  const written = await commit(local, await closeStatements(context, pallets, pallet));
  return written === "stale" ? { kind: "stale" } : { kind: "closed", pallet };
}

/**
 * Closes the open pallet once it holds the shift's boxes per pallet: when the
 * work screen opens and when pallet serials arrive — a pallet that filled
 * while the station had no pallet serials closes then. `null` while it has
 * room (or there is none).
 */
export async function closePalletIfFull(
  context: PalletContext,
  pallets: ShiftPallets,
): Promise<PalletCloseResult | null> {
  const open = await readOpenPallet(context.local, context.pairing, context.shift.copy.id);
  if (open === null || open.boxCount < pallets.capacity) return null;
  return closeOpenPallet(context, pallets);
}

/** A box joining the pallet while it is still open (pinned in both lists of plans). */
export const JOIN_PALLET_SQL =
  "UPDATE floor_pallets SET id = id WHERE id = ? AND host_id = ? AND device_id = ? " +
  "AND closed_at IS NULL";

/** A closed box put on a pallet, once (pinned in both lists of plans). */
export const BOX_ONTO_PALLET_SQL =
  "UPDATE floor_boxes SET pallet_id = ? WHERE id = ? AND host_id = ? AND device_id = ? " +
  "AND closed_at IS NOT NULL AND pallet_id IS NULL";

/**
 * The box close's step of plan ПЛ-Ц (`CloseStep`, plan 2a6): the closing box
 * joins the shift's open pallet — or opens one, whose `opened_at` is the
 * box's close — in the box's own transaction, and its `box_closed` record
 * names the pallet (`palletId`). The box that fills the pallet (the boxes on
 * it reach the shift's boxes per pallet, the cloud's `boxCount + 1 >=
 * palletBoxCapacity`) closes it in the same transaction, after the box's
 * record, with the box's moment: the box never closes without its pallet,
 * and the pallet's `pallet_closed` follows its last box in the outbox. With
 * no pallet serial left, or one that cannot label a pallet (past the range,
 * its SSCC held), the full pallet stays open, the next boxes join it, and it
 * closes when serials come (`closePalletIfFull`), which loses the bad serial.
 */
export function palletStep(context: PalletContext, pallets: ShiftPallets): CloseStep {
  return async (box: ClosingBox) => {
    const { local, pairing, shift } = context;
    const open = await readOpenPallet(local, pairing, shift.copy.id);
    const palletId = open?.id ?? context.newId();
    const statements: LocalStatement[] = [
      open === null
        ? {
            sql:
              "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) " +
              "VALUES (?, ?, ?, ?, ?)",
            values: [palletId, pairing.hostId, pairing.deviceId, box.shiftId, box.closedAt],
            expectedChanges: 1,
          }
        : {
            // Still open when the box joins: a close that landed meanwhile makes it stale.
            sql: JOIN_PALLET_SQL,
            values: [palletId, pairing.hostId, pairing.deviceId],
            expectedChanges: 1,
          },
      {
        sql: BOX_ONTO_PALLET_SQL,
        values: [palletId, box.boxId, pairing.hostId, pairing.deviceId],
        expectedChanges: 1,
      },
    ];
    const boxCount = (open?.boxCount ?? 0) + 1;
    if (boxCount >= pallets.capacity) {
      const next = await nextPalletSerial(context);
      const sscc =
        next === null
          ? null
          : await freePalletSscc(local, shift.snapshot.issuerPrefix, next.serial);
      if (next !== null && sscc !== null) {
        statements.push(
          ...(await closeStatements(context, pallets, {
            palletId,
            shiftId: box.shiftId,
            sscc,
            blockId: next.blockId,
            serial: next.serial,
            openedAt: open?.openedAt ?? box.closedAt,
            closedAt: box.closedAt,
            boxCount,
            itemCount: (open?.itemCount ?? 0) + box.itemCount,
            operatorId: box.operatorId,
          })),
        );
      }
    }
    return { statements, data: { palletId } };
  };
}

/** The check of an open pallet in the close of a shift (pinned in both lists of plans). */
export const OPEN_PALLET_GUARD_SQL =
  "UPDATE floor_shifts AS s SET local_state = local_state WHERE s.host_id = ? " +
  "AND s.device_id = ? AND s.id = ? AND NOT EXISTS (SELECT 1 FROM floor_pallets p " +
  "WHERE p.host_id = s.host_id AND p.device_id = s.device_id AND p.shift_id = s.id " +
  `AND p.closed_at IS NULL AND EXISTS (SELECT 1 ${LIVE_BOXES}))`;

/**
 * The shift's close's own check of plan ПЛ-Ц (`closeShift`'s `guards`, plan
 * 2a8): in the close's transaction, no open pallet of the shift holds a box
 * that is not taken apart — such a pallet is closed first («Закрыть паллету
 * и смену»), so its boxes are on a printed pallet. An open pallet with no box
 * left does not keep the shift open and spends no serial.
 */
export function openPalletGuard(pairing: Pairing, shiftId: string): LocalStatement {
  return {
    sql: OPEN_PALLET_GUARD_SQL,
    values: [pairing.hostId, pairing.deviceId, shiftId],
    expectedChanges: 1,
  };
}
