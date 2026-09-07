import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

const ID = "40000000-0000-4000-8000-000000000004";
const OTHER_ID = "50000000-0000-4000-8000-000000000005";
const DIGEST = "a".repeat(64);
const template = {
  id: ID,
  name: "Duplicate",
  spec: { dpi: 203, elements: [], heightMm: 40, language: "zpl", widthMm: 58 },
};
// Literal canonical JSON is independent of the production serializer.
const templateDigest = createHash("sha256")
  .update(
    `{"id":"${ID}","name":"Duplicate","spec":{"dpi":203,"elements":[],"heightMm":40,"language":"zpl","widthMm":58}}`,
  )
  .digest("hex");
const enabled = {
  mode: "duplicate_dm",
  verification: "required",
  templateId: ID,
  snapshot: { ...template, digest: templateDigest },
  policyRevision: OTHER_ID,
};
const base = {
  eventId: ID,
  jobId: ID,
  attemptId: ID,
  sequence: 1,
  shiftId: ID,
  codeHash: DIGEST,
  acceptedAt: "2026-09-08T10:00:00.000Z",
  policyRevision: ID,
  templateDigest: DIGEST,
  payloadDigest: DIGEST,
  operatorId: ID,
  occurredAt: "2026-09-08T10:00:00.000Z",
};
const prepared = {
  ...base,
  kind: "prepared",
  attemptNo: 1,
  reason: null,
  language: "tspl",
  dpi: 203,
  bytesDigest: DIGEST,
};

describe("validation printing policy", () => {
  it("accepts explicit no-print and either verification setting", () => {
    expect(domain).toHaveProperty("validationPrintInputSchema");
    expect(domain.validationPrintInputSchema.parse({ mode: "none" })).toEqual({ mode: "none" });
    for (const verification of ["required", "none"]) {
      const input = { mode: "duplicate_dm", verification, templateId: ID };
      expect(domain.validationPrintInputSchema.parse(input)).toEqual(input);
      expect(
        domain.validationPrintPolicySchema.parse({ ...enabled, verification }).verification,
      ).toBe(verification);
    }
  });

  it.each([
    undefined,
    {},
    { mode: "none", verification: "required" },
    { mode: "duplicate_dm", templateId: ID },
    { mode: "duplicate_dm", templateId: "not-uuid", verification: "none" },
    { mode: "duplicate_dm", templateId: ID, verification: "skip" },
    { mode: "none", operatorId: ID },
  ])("rejects an unknown or incomplete write instead of silently disabling printing", (input) => {
    expect(domain.validationPrintInputSchema.safeParse(input).success).toBe(false);
  });

  it("requires a full no-print read policy and never fills damaged new contracts", () => {
    const none = {
      mode: "none",
      verification: "none",
      templateId: null,
      snapshot: null,
      policyRevision: null,
    };
    expect(domain.validationPrintPolicySchema.parse(none)).toEqual(none);
    expect(domain.validationPrintPolicySchema.safeParse({ mode: "none" }).success).toBe(false);
    expect(
      domain.validationPrintPolicySchema.safeParse({ ...none, snapshot: enabled.snapshot }).success,
    ).toBe(false);
  });

  it.each([
    { ...enabled, templateId: OTHER_ID },
    { ...enabled, snapshot: null },
    { ...enabled, snapshot: { ...enabled.snapshot, name: "Changed" } },
    { ...enabled, snapshot: { ...enabled.snapshot, digest: "b".repeat(64) } },
    { ...enabled, snapshot: { ...enabled.snapshot, extra: true } },
    { ...enabled, policyRevision: null },
  ])("rejects a mismatched or incomplete immutable snapshot", (policy) => {
    expect(domain.validationPrintPolicySchema.safeParse(policy).success).toBe(false);
  });
});

describe("product label event protocol", () => {
  it("accepts every bounded event shape while retaining exact actor and digests", () => {
    const events = [
      prepared,
      { ...base, kind: "sending" },
      { ...base, kind: "sent" },
      { ...base, kind: "failed_before_send", errorCode: "printer_changed" },
      { ...base, kind: "delivery_unknown", errorCode: "interrupted" },
      { ...base, kind: "verified", scannedPayloadDigest: DIGEST },
      { ...base, kind: "verification_rejected", reason: "mismatch" },
      { ...prepared, attemptNo: 2, reason: "damaged" },
    ];
    for (const event of events) expect(domain.productLabelEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    { ...prepared, raw: "must not cross this channel" },
    { ...prepared, bytesBase64: "AA==" },
    { ...prepared, tenantId: ID },
    { ...prepared, eventId: "bad" },
    { ...prepared, sequence: 0 },
    { ...prepared, sequence: 1.5 },
    { ...prepared, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...prepared, payloadDigest: "A".repeat(64) },
    { ...prepared, operatorId: null },
    { ...prepared, occurredAt: "today" },
    { ...prepared, dpi: 600 },
    { ...prepared, reason: "damaged" },
    { ...prepared, attemptNo: 2, reason: null },
    { ...base, kind: "sent", errorCode: "printer_changed" },
    { ...base, kind: "delivery_unknown", errorCode: "raw exception text" },
  ])("rejects unsafe or inconsistent event data", (event) => {
    expect(domain.productLabelEventSchema.safeParse(event).success).toBe(false);
  });

  it("normalizes UUIDs once at the new boundary", () => {
    const uppercaseId = "ABCDEF00-0000-4000-8000-000000000004";
    expect(
      domain.productLabelEventSchema.parse({ ...prepared, operatorId: uppercaseId }).operatorId,
    ).toBe(uppercaseId.toLowerCase());
  });
});

describe("product label receipts and template choices", () => {
  const receipt = {
    protocol: "validation-dm-duplicate-v1",
    acceptedEventIds: [ID],
    quarantined: [{ eventId: OTHER_ID, code: "parent_missing" }],
  };
  it("keeps explicit accepted and quarantined results", () => {
    expect(domain.productLabelReceiptSchema.parse(receipt)).toEqual(receipt);
  });
  it.each([
    { ...receipt, protocol: "unknown" },
    { ...receipt, acceptedEventIds: [ID, ID] },
    { ...receipt, acceptedEventIds: [OTHER_ID] },
    { ...receipt, quarantined: [{ eventId: OTHER_ID, code: "message from database" }] },
    { ...receipt, quarantined: [receipt.quarantined[0], receipt.quarantined[0]] },
  ])("rejects ambiguous or unrecognized acknowledgement", (value) => {
    expect(domain.productLabelReceiptSchema.safeParse(value).success).toBe(false);
  });
  it("bounds template dimensions and requires a supported printer resolution", () => {
    const item = { id: ID, name: "Duplicate", widthMm: 58, heightMm: 40, dpi: 203 };
    expect(domain.productLabelTemplateListSchema.parse({ items: [item] })).toEqual({
      items: [item],
    });
    expect(
      domain.productLabelTemplateListSchema.safeParse({ items: [{ ...item, dpi: 600 }] }).success,
    ).toBe(false);
    expect(
      domain.productLabelTemplateListSchema.safeParse({ items: [{ ...item, widthMm: 0 }] }).success,
    ).toBe(false);
  });
});
