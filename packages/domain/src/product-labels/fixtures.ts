import { compareDuplicateKm, duplicatePayloadDigest } from "./km.js";
import { applyProductLabelEvent } from "./state.js";
import type { ProductLabelEvent, VerificationPolicy } from "./contracts.js";
import type { ProductLabelProjection } from "./state.js";

const GS = String.fromCharCode(0x1d);
const RAW = `0104600682000013215Y7HG9${GS}93Zf8K`;
const OTHER = `0104600682000013215Y7HG8${GS}93Zf8K`;
const JOB = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_1 = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_2 = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const OPERATOR = "55555555-5555-4555-8555-555555555555";
const REVISION = "66666666-6666-4666-8666-666666666666";
const DIGEST = "a".repeat(64);
const BYTES = "b".repeat(64);

function base(sequence: number, attemptId: string) {
  return {
    eventId: `77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`,
    jobId: JOB,
    attemptId,
    sequence,
    shiftId: SHIFT,
    codeHash: "c".repeat(64),
    acceptedAt: "2026-09-11T08:00:00.000Z",
    policyRevision: REVISION,
    templateDigest: DIGEST,
    payloadDigest: duplicatePayloadDigest(RAW),
    operatorId: OPERATOR,
    occurredAt: "2026-09-11T08:00:01.000Z",
  };
}

function prepared(
  sequence: number,
  attemptId: string,
  attemptNo: number,
  reason: string | null,
): ProductLabelEvent {
  return {
    ...base(sequence, attemptId),
    kind: "prepared",
    attemptNo,
    reason,
    language: "zpl",
    dpi: 203,
    bytesDigest: BYTES,
  } as ProductLabelEvent;
}

function simple(sequence: number, attemptId: string, kind: "sending" | "sent"): ProductLabelEvent {
  return { ...base(sequence, attemptId), kind };
}

function unknown(sequence: number, attemptId: string, errorCode: string): ProductLabelEvent {
  return { ...base(sequence, attemptId), kind: "delivery_unknown", errorCode } as ProductLabelEvent;
}

function failed(sequence: number, attemptId: string, errorCode: string): ProductLabelEvent {
  return {
    ...base(sequence, attemptId),
    kind: "failed_before_send",
    errorCode,
  } as ProductLabelEvent;
}

function verified(sequence: number, attemptId: string, digest: string): ProductLabelEvent {
  return {
    ...base(sequence, attemptId),
    kind: "verified",
    scannedPayloadDigest: digest,
  };
}

function rejected(
  sequence: number,
  attemptId: string,
  reason: "invalid" | "mismatch",
): ProductLabelEvent {
  return {
    ...base(sequence, attemptId),
    kind: "verification_rejected",
    reason,
  };
}

export interface ProductLabelProjectionCase {
  name: string;
  verification: VerificationPolicy;
  events: ProductLabelEvent[];
  /** Index of the first event the domain refuses, or null when the whole run applies. */
  invalidAt: number | null;
  projection: ProductLabelProjection | null;
}

function run(
  name: string,
  verification: VerificationPolicy,
  events: ProductLabelEvent[],
): ProductLabelProjectionCase {
  let projection: ProductLabelProjection | null = null;
  for (let index = 0; index < events.length; index++) {
    try {
      projection = applyProductLabelEvent(projection, events[index]!, verification);
    } catch {
      return { name, verification, events, invalidAt: index, projection };
    }
  }
  return { name, verification, events, invalidAt: null, projection };
}

/**
 * The fifth fixture set the handheld consumes, after the code parser, the
 * inventory classifier, the label emitters and the box label's fields.
 *
 * The server validates these same events, so a Kotlin port that disagrees
 * produces batches the server quarantines. Cases whose `invalidAt` is set are
 * as load-bearing as the ones that apply: each names a transition the device
 * must not attempt.
 */
export function buildProductLabelFixtures() {
  const cases: ProductLabelProjectionCase[] = [
    run("printed under no verification", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
    ]),
    run("awaiting verification", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
    ]),
    run("verified", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
    ]),
    run("a rejected verification settles nothing", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      rejected(4, ATTEMPT_1, "mismatch"),
    ]),
    run("an unknown delivery is resolved by a scan under no verification", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      unknown(3, ATTEMPT_1, "transport_failed"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
    ]),
    run("an interrupted send needs attention", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      unknown(3, ATTEMPT_1, "interrupted"),
    ]),
    run("nothing was sent", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      failed(2, ATTEMPT_1, "printer_changed"),
    ]),
    run("a reprint replays the same bytes", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      prepared(4, ATTEMPT_2, 2, "damaged"),
      simple(5, ATTEMPT_2, "sending"),
      simple(6, ATTEMPT_2, "sent"),
    ]),
    // A verified label can still be damaged or lost afterwards, so the job
    // takes a new attempt -- and under `required` the reprint drops back to
    // `pending`, because the new sticker has to be scanned back in its turn.
    run("a completed job still takes a reprint, which must be verified again", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
      prepared(5, ATTEMPT_2, 2, "lost"),
    ]),
    // What IS frozen is the verified attempt: nothing may be appended to it.
    run("a verified attempt takes no further event of its own", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(RAW)),
      rejected(5, ATTEMPT_1, "mismatch"),
    ]),
    run("a gap in the sequence is refused", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(3, ATTEMPT_1, "sending"),
    ]),
    run("a reprint may not change the bytes", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      { ...prepared(4, ATTEMPT_2, 2, "damaged"), bytesDigest: "d".repeat(64) } as ProductLabelEvent,
    ]),
    run("a reprint may not start while an attempt is in flight", "none", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      prepared(3, ATTEMPT_2, 2, "damaged"),
    ]),
    run("a verification carrying the wrong digest is refused", "required", [
      prepared(1, ATTEMPT_1, 1, null),
      simple(2, ATTEMPT_1, "sending"),
      simple(3, ATTEMPT_1, "sent"),
      verified(4, ATTEMPT_1, duplicatePayloadDigest(OTHER)),
    ]),
  ];

  return {
    projection: cases,
    compare: [
      { name: "same code", expected: RAW, scanned: RAW, result: compareDuplicateKm(RAW, RAW) },
      {
        name: "a different unit of the same product",
        expected: RAW,
        scanned: OTHER,
        result: compareDuplicateKm(RAW, OTHER),
      },
      {
        name: "the identity without its crypto tail is NOT a match",
        expected: RAW,
        scanned: "0104600682000013215Y7HG9",
        result: compareDuplicateKm(RAW, "0104600682000013215Y7HG9"),
      },
      {
        name: "unreadable",
        expected: RAW,
        scanned: "garbage",
        result: compareDuplicateKm(RAW, "garbage"),
      },
    ],
    payloadDigest: [RAW, OTHER].map((raw) => ({ raw, digest: duplicatePayloadDigest(raw) })),
  };
}
