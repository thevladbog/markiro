import { describe, expect, it } from "vitest";
import * as contracts from "../src/offline-grants.js";

describe("negotiated offline evidence transport", () => {
  it("exposes strict envelope and durable receipt schemas", () => {
    expect(contracts).toHaveProperty("grantEvidenceEnvelopeSchema");
    expect(contracts).toHaveProperty("grantEvidenceReceiptSchema");
  });
});

describe("strict evidence shape", () => {
  const body = {
    protocol: "offline-grants-v1",
    batchId: "native:1",
    payloadDigest: "a".repeat(64),
    grants: ["original.compact.bytes"],
    eventGrants: {
      "/events/0#inventory.repack.v1": "018f7bd1-4420-4b13-9f77-89f3a5374763",
      "/events/0#inventory.box.close.v1": "018f7bd1-4420-4b13-9f77-89f3a5374763",
    },
    payload: { raw: "01ABC\u001d91XYZ" },
  };
  it("supports two sub-effects for one untouched native event", () => {
    expect(contracts.grantEvidenceEnvelopeSchema.parse(body)).toEqual(body);
  });
  it("rejects client mode, raw cost and invalid event links", () => {
    for (const extra of [{ mode: "observe" }, { cost: { units: 0 } }])
      expect(contracts.grantEvidenceEnvelopeSchema.safeParse({ ...body, ...extra }).success).toBe(
        false,
      );
    expect(
      contracts.grantEvidenceEnvelopeSchema.safeParse({
        ...body,
        eventGrants: { "/events/0": "unknown" },
      }).success,
    ).toBe(false);
  });
  it("preserves accepted evidence with rejected production as a distinct result", () => {
    const response = {
      protocol: "offline-grants-v1",
      batchId: "native:1",
      outcome: "accepted",
      reason: null,
      receiptId: "018f7bd1-4420-4b13-9f77-89f3a5374763",
      reconciliation: {
        status: "rejected",
        statusCode: 409,
        result: { code: "INVENTORY_LEAVE_PENDING_WORK" },
      },
    };
    expect(contracts.grantEvidenceReceiptSchema.parse(response)).toEqual(response);
  });
});
