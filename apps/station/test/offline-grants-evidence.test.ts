import { describe, expect, it } from "vitest";
import { productLabelValueDigest } from "@markiro/domain";
import {
  buildStationEvidenceEnvelope,
  parseStationEvidenceReceipt,
} from "../src/lib/offline-grants/evidence.js";

const grantId = "11111111-1111-4111-8111-111111111111";
const receiptId = "22222222-2222-4222-8222-222222222222";

describe("Station original evidence transport", () => {
  it("keeps original native bytes and both independently charged repack links", () => {
    const payload = {
      batchId: "native",
      events: [
        {
          eventId: "event",
          kind: "item",
          raw: "010460068200001321ABC\u001d93tail",
          repack: { action: "add-item" },
        },
      ],
    };
    const envelope = buildStationEvidenceEnvelope("batch", payload, [
      { pointer: "/events/0#inventory.repack.v1", grantId, compact: "original.compact.bytes" },
      { pointer: "/events/0#inventory.box.close.v1", grantId, compact: "original.compact.bytes" },
    ]);
    expect(envelope.payload).toEqual(payload);
    expect(envelope.payloadDigest).toBe(productLabelValueDigest(payload));
    expect(envelope.grants).toEqual(["original.compact.bytes"]);
    expect(envelope.eventGrants).toEqual({
      "/events/0#inventory.repack.v1": grantId,
      "/events/0#inventory.box.close.v1": grantId,
    });
  });
  it("wraps authenticated observe evidence with no grant and never invents one", () => {
    const envelope = buildStationEvidenceEnvelope("batch", { items: [] }, []);
    expect(envelope.grants).toEqual([]);
    expect(envelope.eventGrants).toEqual({});
    expect(() =>
      buildStationEvidenceEnvelope("batch", {}, [
        { pointer: "/items/0#shift.scan.v1", grantId, compact: null },
      ]),
    ).toThrow();
  });
  it("does not confuse a duplicate receipt with production acceptance", () => {
    const envelope = buildStationEvidenceEnvelope("batch", { items: [] }, []);
    const raw = {
      protocol: "offline-grants-v1",
      batchId: "batch",
      outcome: "duplicate",
      reason: "late_no_proof",
      receiptId,
      reconciliation: { status: "not_applied", statusCode: null, result: null },
    };
    expect(parseStationEvidenceReceipt(raw, envelope)).toEqual({ receipt: raw, native: null });
    const conflict = {
      ...raw,
      reconciliation: { status: "rejected", statusCode: 201, result: { outcome: "conflict" } },
    };
    expect(parseStationEvidenceReceipt(conflict, envelope).native).toEqual({ outcome: "conflict" });
    expect(() => parseStationEvidenceReceipt({ ...raw, batchId: "other" }, envelope)).toThrow();
    expect(() =>
      parseStationEvidenceReceipt(
        { ...conflict, reconciliation: { ...conflict.reconciliation, statusCode: "201" } },
        envelope,
      ),
    ).toThrow();
  });
});
