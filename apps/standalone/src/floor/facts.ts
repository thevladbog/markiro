import { kmHash, type ParsedKm } from "@markiro/domain";

import {
  factRecordSchema,
  type BoxClosedFact,
  type BoxExceptionFact,
  type BoxLabelFact,
  type FactRecord,
  type ScanFact,
  type ScannedCode,
  type ShiftClosedFact,
} from "../host/protocol.js";
import type { LocalStatement } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";

/**
 * The envelope of a record: its own id (a UUID this station made up, which
 * keys the host's receipt), the shift, and the operator signed in.
 */
export interface RecordHead {
  id: string;
  shiftId: string;
  operatorId: string | null;
}

/** A `scan` record: every scan of the work screen, accepted or not. */
export function scanRecord(head: RecordHead, data: ScanFact): FactRecord {
  return { ...head, kind: "scan", data };
}

/** A `box_closed` record: a box closed with the SSCC of one of this station's blocks. */
export function boxClosedRecord(head: RecordHead, data: BoxClosedFact): FactRecord {
  return { ...head, kind: "box_closed", data };
}

/** A `box_label` record: the check of a closed box's label (plan 2a7). */
export function boxLabelRecord(head: RecordHead, data: BoxLabelFact): FactRecord {
  return { ...head, kind: "box_label", data };
}

/** A `box_exception` record (plan 2a8). */
export function boxExceptionRecord(head: RecordHead, data: BoxExceptionFact): FactRecord {
  return { ...head, kind: "box_exception", data };
}

/** A `shift_closed` record: this station closed its shift (plan 2a8). */
export function shiftClosedRecord(head: RecordHead, data: ShiftClosedFact): FactRecord {
  return { ...head, kind: "shift_closed", data };
}

/**
 * A code of marking as a fact carries it, from what the domain's
 * `canonicalizeKm` read: the hash that identifies the code (`kmHash`, without
 * its crypto tail), its GTIN and serial, and the canonical text with its
 * group separators and tail, which the exports of stage 4 need.
 */
export function scannedCode(km: ParsedKm): ScannedCode {
  return { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial, canonical: km.raw };
}

/**
 * The largest record the outbox keeps, in bytes of its JSON. A scan's record
 * is about 1.3 KB at most (a canonical code of 1024 bytes), so this only
 * keeps out a record no fact makes; and a batch of 100 such records stays
 * under the host's 2 MiB body limit, past which the host answers 400
 * `validation_failed` and the same batch would be refused for good.
 */
export const MAX_RECORD_BYTES = 16 * 1024;

/** A record larger than `MAX_RECORD_BYTES`: never kept, so it can never block the outbox. */
export class RecordTooLargeError extends Error {
  constructor(bytes: number) {
    super(`a record of ${bytes} bytes`);
    this.name = "RecordTooLargeError";
  }
}

/**
 * The outbox row of a record, for the transaction that writes the fact
 * itself (stage 2a spec, decision 11): the record is checked against its
 * schema and its size first, so a record this build cannot form, or one too
 * large to send, is never kept, and it is kept whole as the payload it is
 * sent as. A shift this station has closed (`local_state`, plan 2a8) takes
 * no record any more: its `shift_closed` is its last, and the row of any
 * later one changes nothing, so its whole transaction is refused
 * (`changes_mismatch`). The host would mark the station's own shift late
 * for a record after its close (plan 2a2).
 */
export function outboxStatement(
  record: FactRecord,
  pairing: Pairing,
  createdAt: string,
): LocalStatement {
  const checked = factRecordSchema.parse(record);
  const payload = JSON.stringify(checked);
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_RECORD_BYTES) throw new RecordTooLargeError(bytes);
  return {
    sql:
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
      "SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM floor_shifts " +
      "WHERE host_id = ? AND device_id = ? AND id = ? AND local_state IS NOT NULL)",
    values: [
      checked.id,
      pairing.hostId,
      pairing.deviceId,
      checked.kind,
      checked.shiftId,
      payload,
      createdAt,
      pairing.hostId,
      pairing.deviceId,
      checked.shiftId,
    ],
    expectedChanges: 1,
  };
}

/**
 * The station's `floor_exceptions` row and the `box_exception` record of one
 * exception (stage 2a spec §5.7.6), for the transaction that applies its
 * consequences: the same fields in both, so the audit row and the fact the
 * host receives never differ. The ONE writer of both rows — every kind, the
 * reprint of a box whose label waits (plan 2a7, `printAgain`) and the
 * exceptions of plan 2a8 alike.
 */
export function exceptionStatements(
  context: { pairing: Pairing; operatorId: string; newId: () => string },
  shiftId: string,
  data: BoxExceptionFact,
): LocalStatement[] {
  const { pairing, operatorId } = context;
  const rowId = context.newId();
  const record = boxExceptionRecord({ id: context.newId(), shiftId, operatorId }, data);
  return [
    {
      sql:
        "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, code_hash, " +
        "target_scanned_at, reason_code, reason_text, occurred_at, operator_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      values: [
        rowId,
        pairing.hostId,
        pairing.deviceId,
        shiftId,
        data.exception,
        data.boxId,
        data.codeHash,
        data.targetScannedAt,
        data.reasonCode,
        data.reasonText,
        data.occurredAt,
        operatorId,
      ],
      expectedChanges: 1,
    },
    outboxStatement(record, pairing, data.occurredAt),
  ];
}
