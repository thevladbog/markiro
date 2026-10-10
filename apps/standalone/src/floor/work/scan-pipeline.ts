import { classifyScan, type ParsedKm } from "@markiro/domain";
import { z } from "zod";

import type { CodeCheck, CodeOwner, ScanFact, ScanRawKind } from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { outboxStatement, scanRecord, scannedCode, type RecordHead } from "../facts.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { readOpenBox } from "./work-reads.js";

/**
 * The longest serial the host keeps, in bytes of UTF-8 (`MAX_SERIAL_BYTES`,
 * `host/src/facts/scan.rs`). A GS1 serial has 20 characters at most, so a
 * longer one is no code of marking for the host: the station reads such a
 * scan as unknown rather than keep a code the host would refuse.
 */
export const HOST_MAX_SERIAL_BYTES = 64;

/** What the scan looked like: a code of marking the domain read, or what else it was. */
export type ScanReading = { kind: "km"; km: ParsedKm } | { kind: Exclude<ScanRawKind, "km"> };

/**
 * The one reading of a scan (stage 2a spec §5.7.3, step 1): the domain's
 * `classifyScan`, which strips the AIM prefixes and keeps the group
 * separators; an SSCC is no code of marking on the work screen (plan 2a7
 * reads a label's SSCC before the pipeline), nor a GTIN or anything else.
 */
export function readScan(raw: string): ScanReading {
  const scan = classifyScan(raw);
  if (scan.kind !== "km") return { kind: scan.kind };
  if (new TextEncoder().encode(scan.km.serial).length > HOST_MAX_SERIAL_BYTES) {
    return { kind: "unknown" };
  }
  return { kind: "km", km: scan.km };
}

export interface ScanContext {
  local: LocalExecutor;
  pairing: Pairing;
  shift: WorkShift;
  /** The operator of the session (`FloorSession.id`). */
  operatorId: string;
  /** The link is `online` right now: only then is the host asked. */
  online: () => boolean;
  /** `HostApi.checkCode` (300 ms). */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /** A failed host call the shell may act on: a refused key, another certificate. */
  onHostError: (error: unknown) => void;
  now: () => Date;
  newId: () => string;
}

/** What became of a scan; every outcome is in `floor_scans` and the outbox. */
export type ScanOutcome =
  | { kind: "accepted"; boxId: string; itemCount: number }
  | { kind: "duplicate"; source: "local"; firstScannedAt: string }
  | { kind: "duplicate"; source: "host"; firstScannedAt: string; shiftNumber: string }
  | { kind: "wrong_gtin"; gtin14: string }
  | { kind: "invalid"; rawKind: Exclude<ScanRawKind, "km"> };

const localOwnerRow = z.object({ scanned_at: z.string() });

/** When this station accepted the code, if it holds it in a box of this pairing. */
async function readLocalOwner(
  context: ScanContext,
  codeHash: string,
): Promise<{ scannedAt: string } | null> {
  const [row] = await context.local.query(
    "SELECT scanned_at FROM floor_codes WHERE host_id = ? AND device_id = ? AND code_hash = ?",
    [context.pairing.hostId, context.pairing.deviceId, codeHash],
    localOwnerRow,
  );
  return row === undefined ? null : { scannedAt: row.scanned_at };
}

/**
 * Another device's scan the host knows owns the code (stage 2a spec §5.7.3,
 * step 4), asked only while the link is `online`. No answer in 300 ms, any
 * failure, `free`, and a scan of this very station (whose own registry is
 * newer than the host's: an undo it has not sent yet) all let the scan
 * through; a duplicate the host finds later is a `conflict` receipt.
 */
async function hostOwner(context: ScanContext, codeHash: string): Promise<CodeOwner | null> {
  if (!context.online()) return null;
  let check: CodeCheck;
  try {
    check = await context.checkCode(codeHash);
  } catch (error) {
    context.onHostError(error);
    return null;
  }
  if (check.status !== "taken" || check.owner.sameDevice) return null;
  return check.owner;
}

function scanRow(context: ScanContext, id: string, data: ScanFact): LocalStatement {
  const { pairing, shift, operatorId } = context;
  return {
    sql:
      "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, " +
      "duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, " +
      "scanned_at, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    values: [
      id,
      pairing.hostId,
      pairing.deviceId,
      shift.copy.id,
      data.boxId,
      data.verdict,
      data.duplicateSource,
      data.rawKind,
      data.rawLength,
      data.code?.codeHash ?? null,
      data.code?.gtin14 ?? null,
      data.code?.serial ?? null,
      data.code?.canonical ?? null,
      data.scannedAt,
      operatorId,
    ],
    expectedChanges: 1,
  };
}

/**
 * One scan of the work screen (stage 2a spec §5.7.3), run strictly one at a
 * time (`createWorkQueue`): read it; a code of another product is
 * `wrong_gtin`; a code this station holds is a local duplicate; a code
 * another device's scan owns on the host is a host duplicate; otherwise it
 * is accepted into the shift's open box, which opens with it. Every scan is
 * journalled with its outbox record in ONE transaction: the accepted one with
 * its box and its place in `floor_codes`, whose key keeps a code in one box
 * of the pairing at most — a second accept of a code the check missed fails
 * whole (`changes_mismatch`) and writes nothing. A scan that is no code
 * keeps its length and kind, never its text (decision 15: it may be a
 * badge). A failed write rejects: the scan is not taken, and the screen says
 * so.
 */
export async function processScan(context: ScanContext, raw: string): Promise<ScanOutcome> {
  const { local, pairing, shift } = context;
  const scannedAt = context.now().toISOString();
  const head: RecordHead = {
    id: context.newId(),
    shiftId: shift.copy.id,
    operatorId: context.operatorId,
  };
  const journal = async (data: ScanFact, more: readonly LocalStatement[] = []) => {
    await local.transaction([
      ...more,
      scanRow(context, head.id, data),
      outboxStatement(scanRecord(head, data), pairing, scannedAt),
    ]);
  };
  const reading = readScan(raw);
  const base = { scannedAt, rawLength: raw.length };
  if (reading.kind !== "km") {
    await journal({
      ...base,
      verdict: "invalid",
      duplicateSource: null,
      rawKind: reading.kind,
      code: null,
      boxId: null,
    });
    return { kind: "invalid", rawKind: reading.kind };
  }
  const code = scannedCode(reading.km);
  const refused = { ...base, rawKind: "km" as const, code, boxId: null };
  if (code.gtin14 !== shift.snapshot.product.gtin14) {
    await journal({ ...refused, verdict: "wrong_gtin", duplicateSource: null });
    return { kind: "wrong_gtin", gtin14: code.gtin14 };
  }
  const mine = await readLocalOwner(context, code.codeHash);
  if (mine !== null) {
    await journal({ ...refused, verdict: "duplicate", duplicateSource: "local" });
    return { kind: "duplicate", source: "local", firstScannedAt: mine.scannedAt };
  }
  const owner = await hostOwner(context, code.codeHash);
  if (owner !== null) {
    await journal({ ...refused, verdict: "duplicate", duplicateSource: "host" });
    return {
      kind: "duplicate",
      source: "host",
      firstScannedAt: owner.scannedAt,
      shiftNumber: owner.shiftNumber,
    };
  }
  const box = await readOpenBox(local, pairing, shift.copy.id);
  const boxId = box?.id ?? context.newId();
  const intoBox: LocalStatement =
    box === null
      ? {
          sql:
            "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) " +
            "VALUES (?, ?, ?, ?, ?, 1)",
          values: [boxId, pairing.hostId, pairing.deviceId, shift.copy.id, scannedAt],
          expectedChanges: 1,
        }
      : {
          sql:
            "UPDATE floor_boxes SET item_count = item_count + 1 " +
            "WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL",
          values: [boxId, pairing.hostId, pairing.deviceId],
          expectedChanges: 1,
        };
  const claim: LocalStatement = {
    sql:
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
      "scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    values: [
      pairing.hostId,
      pairing.deviceId,
      code.codeHash,
      shift.copy.id,
      boxId,
      head.id,
      scannedAt,
    ],
    expectedChanges: 1,
  };
  await journal({ ...refused, verdict: "ok", duplicateSource: null, boxId }, [intoBox, claim]);
  return { kind: "accepted", boxId, itemCount: (box?.itemCount ?? 0) + 1 };
}
