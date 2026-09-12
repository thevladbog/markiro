import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import type { ProductLabelEvent, VerificationPolicy } from "../src/index.js";

const ID = "40000000-0000-4000-8000-000000000004";
const SECOND = "50000000-0000-4000-8000-000000000005";
const DIGEST = "a".repeat(64);
const BASE = {
  eventId: ID,
  jobId: ID,
  attemptId: ID,
  shiftId: ID,
  codeHash: DIGEST,
  acceptedAt: "2026-09-08T10:00:00.000Z",
  policyRevision: ID,
  templateDigest: DIGEST,
  payloadDigest: DIGEST,
  operatorId: ID,
  occurredAt: "2026-09-08T10:00:00.000Z",
};
const PREPARED: Extract<ProductLabelEvent, { kind: "prepared" }> = {
  ...BASE,
  kind: "prepared",
  sequence: 1,
  attemptNo: 1,
  reason: null,
  language: "zpl",
  dpi: 203,
  bytesDigest: DIGEST,
};
const SENDING: ProductLabelEvent = { ...BASE, eventId: SECOND, kind: "sending", sequence: 2 };
const SENT: ProductLabelEvent = { ...BASE, kind: "sent", sequence: 3 };
const UNKNOWN: ProductLabelEvent = {
  ...BASE,
  kind: "delivery_unknown",
  sequence: 3,
  errorCode: "interrupted",
};
const VERIFIED: ProductLabelEvent = {
  ...BASE,
  kind: "verified",
  sequence: 4,
  scannedPayloadDigest: DIGEST,
};

function project(verification: VerificationPolicy, events: ProductLabelEvent[]) {
  let current: domain.ProductLabelProjection | null = null;
  for (const event of events) current = domain.applyProductLabelEvent(current, event, verification);
  if (!current) throw new Error("Test requires at least one event");
  return current;
}

describe("product label status", () => {
  it.each([
    ["prepared", "required", false, "prepared"],
    ["sending", "none", false, "sending"],
    ["sent", "none", false, "completed"],
    ["sent", "required", false, "awaiting_verification"],
    ["failed_before_send", "none", false, "attention"],
    ["delivery_unknown", "none", false, "attention"],
    ["delivery_unknown", "required", false, "attention"],
    ["delivery_unknown", "required", true, "completed"],
  ] as const)("maps %s / %s / verified=%s to %s", (attempt, verification, verified, expected) => {
    expect(domain.productLabelStatus(attempt, verification, verified)).toBe(expected);
  });

  it("does not declare an unsent attempt complete even with a corrupt verified flag", () => {
    expect(() => domain.productLabelStatus("prepared", "required", true)).toThrowError(
      expect.objectContaining({ code: "PRODUCT_LABEL_TRANSITION_INVALID" }),
    );
  });
});

describe("product label transitions", () => {
  it.each([
    {
      name: "prepared",
      verification: "required",
      prefix: [PREPARED],
      allowed: ["sending", "failed_before_send"],
    },
    {
      name: "sending",
      verification: "required",
      prefix: [PREPARED, SENDING],
      allowed: ["sent", "delivery_unknown"],
    },
    {
      name: "sent required",
      verification: "required",
      prefix: [PREPARED, SENDING, SENT],
      allowed: ["prepared", "verified", "verification_rejected", "verification_skipped"],
    },
    {
      name: "sent none",
      verification: "none",
      prefix: [PREPARED, SENDING, SENT],
      allowed: ["prepared"],
    },
    {
      name: "unknown",
      verification: "none",
      prefix: [PREPARED, SENDING, UNKNOWN],
      allowed: ["prepared", "verified", "verification_rejected"],
    },
    {
      name: "verified",
      verification: "required",
      prefix: [PREPARED, SENDING, SENT, VERIFIED],
      allowed: ["prepared"],
    },
  ] satisfies Array<{
    name: string;
    verification: VerificationPolicy;
    prefix: ProductLabelEvent[];
    allowed: string[];
  }>)(
    "enforces the complete outgoing event matrix from $name",
    ({ verification, prefix, allowed }) => {
      const current = project(verification, prefix);
      const sequence = current.latestSequence + 1;
      const events: ProductLabelEvent[] = [
        { ...PREPARED, attemptId: SECOND, attemptNo: 2, reason: "lost", sequence },
        { ...SENDING, sequence },
        { ...SENT, sequence },
        { ...UNKNOWN, sequence },
        { ...BASE, kind: "failed_before_send", errorCode: "printer_changed", sequence },
        { ...VERIFIED, sequence },
        { ...BASE, kind: "verification_rejected", reason: "invalid", sequence },
        { ...BASE, kind: "verification_skipped", sequence },
      ];
      for (const event of events)
        expect(domain.canApplyProductLabelEvent(current, event), event.kind).toBe(
          allowed.includes(event.kind),
        );
    },
  );

  it("waits for a persisted matching verification when it is required", () => {
    expect(domain).toHaveProperty("applyProductLabelEvent", expect.any(Function));
    const sent = project("required", [PREPARED, SENDING, SENT]);
    expect(sent).toMatchObject({
      status: "awaiting_verification",
      verificationOutcome: "pending",
      latestSequence: 3,
    });
    const confirmed = domain.applyProductLabelEvent(sent, VERIFIED, "required");
    expect(confirmed).toMatchObject({
      status: "completed",
      verificationOutcome: "verified",
      latestSequence: 4,
      attemptState: "sent",
    });
    expect(sent.verificationOutcome).toBe("pending");
  });

  it("completes ordinary no-verification delivery without inventing a verification", () => {
    const sent = project("none", [PREPARED, SENDING, SENT]);
    expect(sent).toMatchObject({ status: "completed", verificationOutcome: "not_required" });
    expect(domain.canApplyProductLabelEvent(sent, VERIFIED)).toBe(false);
  });

  it.each(["none", "required"] as const)(
    "allows a matching recovery scan after unknown delivery (%s)",
    (verification) => {
      const unknown = project(verification, [PREPARED, SENDING, UNKNOWN]);
      expect(unknown.status).toBe("attention");
      const confirmed = domain.applyProductLabelEvent(unknown, VERIFIED, verification);
      expect(confirmed).toMatchObject({
        status: "completed",
        verificationOutcome: "verified",
        attemptState: "delivery_unknown",
      });
    },
  );

  it("records mismatch as a fact without resolving the job", () => {
    const sent = project("required", [PREPARED, SENDING, SENT]);
    const rejected: ProductLabelEvent = {
      ...BASE,
      kind: "verification_rejected",
      reason: "mismatch",
      sequence: 4,
    };
    expect(domain.applyProductLabelEvent(sent, rejected, "required")).toMatchObject({
      status: "awaiting_verification",
      verificationOutcome: "pending",
      latestSequence: 4,
    });
  });

  it("preserves the prior verification and opens a fresh explicit reprint attempt", () => {
    const confirmed = project("required", [PREPARED, SENDING, SENT, VERIFIED]);
    const repeat: ProductLabelEvent = {
      ...PREPARED,
      eventId: SECOND,
      attemptId: SECOND,
      operatorId: SECOND,
      sequence: 5,
      attemptNo: 2,
      reason: "damaged",
    };
    const next = domain.applyProductLabelEvent(confirmed, repeat, "required");
    expect(next).toMatchObject({
      status: "prepared",
      verificationOutcome: "pending",
      attemptNo: 2,
      attemptId: SECOND,
    });
    expect(confirmed).toMatchObject({ verificationOutcome: "verified", attemptId: ID });
    expect(domain.canApplyProductLabelEvent(next, { ...VERIFIED, sequence: 6 })).toBe(false);
  });

  it("retains failures before I/O and permits an explicitly reasoned retry", () => {
    const failed: ProductLabelEvent = {
      ...BASE,
      kind: "failed_before_send",
      errorCode: "printer_unconfigured",
      sequence: 2,
    };
    const current = project("none", [PREPARED, failed]);
    expect(current).toMatchObject({ status: "attention", attemptState: "failed_before_send" });
    const repeat: ProductLabelEvent = {
      ...PREPARED,
      attemptId: SECOND,
      sequence: 3,
      attemptNo: 2,
      reason: "not_printed",
    };
    expect(domain.applyProductLabelEvent(current, repeat, "none")).toMatchObject({
      attemptNo: 2,
      status: "prepared",
      verificationOutcome: "not_required",
    });
  });

  it.each<ProductLabelEvent>([
    { ...VERIFIED, sequence: 3 },
    { ...VERIFIED, sequence: 5 },
    { ...VERIFIED, attemptId: SECOND },
    { ...VERIFIED, jobId: SECOND },
    { ...VERIFIED, payloadDigest: "b".repeat(64) },
    { ...VERIFIED, scannedPayloadDigest: "b".repeat(64) },
    { ...VERIFIED, shiftId: SECOND },
    { ...VERIFIED, codeHash: "b".repeat(64) },
    { ...VERIFIED, acceptedAt: "2026-09-09T10:00:00.000Z" },
    { ...VERIFIED, policyRevision: SECOND },
    { ...VERIFIED, templateDigest: "b".repeat(64) },
  ])("rejects stale, gapped, or reassigned facts without mutating the projection", (event) => {
    const sent = project("required", [PREPARED, SENDING, SENT]);
    const before = structuredClone(sent);
    expect(domain.canApplyProductLabelEvent(sent, event)).toBe(false);
    expect(() => domain.applyProductLabelEvent(sent, event, "required")).toThrowError(
      expect.objectContaining({ code: "PRODUCT_LABEL_TRANSITION_INVALID" }),
    );
    expect(sent).toEqual(before);
  });

  it.each<ProductLabelEvent>([
    SENT,
    VERIFIED,
    { ...PREPARED, sequence: 2 },
    { ...PREPARED, attemptNo: 2, reason: "lost" },
  ])("does not start a journal with anything but the initial prepared event", (event) => {
    expect(() => domain.applyProductLabelEvent(null, event, "required")).toThrowError(
      expect.objectContaining({ code: "PRODUCT_LABEL_TRANSITION_INVALID" }),
    );
  });

  it("does not resend while sending or resolve an unsent code", () => {
    const prepared = project("required", [PREPARED]);
    const sending = project("required", [PREPARED, SENDING]);
    expect(domain.canApplyProductLabelEvent(prepared, { ...VERIFIED, sequence: 2 })).toBe(false);
    expect(
      domain.canApplyProductLabelEvent(sending, {
        ...PREPARED,
        attemptId: SECOND,
        attemptNo: 2,
        reason: "lost",
        sequence: 3,
      }),
    ).toBe(false);
    expect(domain.canApplyProductLabelEvent(sending, { ...SENDING, sequence: 3 })).toBe(false);
  });

  it("cannot change frozen verification or print contents on a reprint", () => {
    const sent = project("required", [PREPARED, SENDING, SENT]);
    expect(() => domain.applyProductLabelEvent(sent, VERIFIED, "none")).toThrow();
    const repeat: ProductLabelEvent = {
      ...PREPARED,
      attemptId: SECOND,
      sequence: 4,
      attemptNo: 2,
      reason: "lost",
    };
    for (const event of [
      { ...repeat, bytesDigest: "b".repeat(64) },
      { ...repeat, dpi: 300 as const },
      { ...repeat, language: "tspl" as const },
      { ...repeat, attemptId: ID },
    ]) {
      expect(domain.canApplyProductLabelEvent(sent, event)).toBe(false);
    }
  });
});

describe("explicit verification skip", () => {
  const skipped: ProductLabelEvent = { ...BASE, kind: "verification_skipped", sequence: 4 };

  it("records a completed but unverified attempt and permits a later reprint", () => {
    expect(domain.productLabelEventSchema.safeParse(skipped).success).toBe(true);
    const current = project("required", [PREPARED, SENDING, SENT, skipped]);
    expect(current).toMatchObject({
      status: "completed",
      verificationOutcome: "skipped",
      attemptState: "sent",
    });
    expect(domain.canApplyProductLabelEvent(current, { ...VERIFIED, sequence: 5 })).toBe(false);
    expect(domain.canApplyProductLabelEvent(current, { ...skipped, sequence: 5 })).toBe(false);
    const reprinted = domain.applyProductLabelEvent(
      current,
      {
        ...PREPARED,
        attemptId: SECOND,
        attemptNo: 2,
        reason: "lost",
        sequence: 5,
      },
      "required",
    );
    expect(reprinted.verificationOutcome).toBe("pending");
  });

  it("does not use a verification skip to resolve unprinted or unknown output", () => {
    for (const prefix of [[PREPARED], [PREPARED, SENDING], [PREPARED, SENDING, UNKNOWN]]) {
      const current = project("required", prefix);
      expect(
        domain.canApplyProductLabelEvent(current, {
          ...skipped,
          sequence: current.latestSequence + 1,
        }),
      ).toBe(false);
    }
    expect(
      domain.canApplyProductLabelEvent(project("none", [PREPARED, SENDING, SENT]), skipped),
    ).toBe(false);
  });
});
