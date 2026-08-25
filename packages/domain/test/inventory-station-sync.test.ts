import { describe, expect, it } from "vitest";

import {
  inventoryEventBatchDigest,
  parseInventoryEventBatch,
  parseInventoryEventBatchResponse,
} from "../src/index.js";

const event = {
  eventId: "11111111-1111-4111-8111-111111111111",
  deviceSequence: 7,
  operatorId: "22222222-2222-4222-8222-222222222222",
  scannedAt: "2026-08-25T10:00:00.000Z",
  kind: "item" as const,
  normalizedIdentity: `item:${"a".repeat(64)}`,
  codeHash: "a".repeat(64),
  canonicalRaw: "010460000000001521SERIAL",
  activeProductionDate: "2026-08-20",
  localVerdict: "expected" as const,
};

const payload = {
  snapshotId: "33333333-3333-4333-8333-333333333333",
  snapshotRevision: 1 as const,
  sequenceCeiling: 7,
  pendingEventCount: 0,
  openBoxCount: 0,
  events: [event],
};

describe("inventory station sync contract", () => {
  it("uses one deterministic canonical digest independent of a batch id", () => {
    expect(inventoryEventBatchDigest(payload)).toBe(
      "833603f1d134151319c41bdf7a1d8eb9ac38858db3d530dd3a5c7696e18f8535",
    );
  });

  it("rejects unordered, duplicate, oversized, and open event shapes", () => {
    const reversed = {
      ...payload,
      sequenceCeiling: 8,
      events: [{ ...event, deviceSequence: 8 }, event],
    };
    expect(() =>
      parseInventoryEventBatch({
        batchId: "batch-1",
        payloadDigest: inventoryEventBatchDigest(reversed),
        ...reversed,
      }),
    ).toThrow("Invalid inventory event batch");
    expect(() =>
      parseInventoryEventBatch({
        batchId: "batch-1",
        payloadDigest: inventoryEventBatchDigest(payload),
        ...payload,
        unexpected: true,
      }),
    ).toThrow("Invalid inventory event batch");
  });

  it("recognizes a response only when every requested event is accounted for exactly once", () => {
    const digest = inventoryEventBatchDigest(payload);
    expect(() =>
      parseInventoryEventBatchResponse(
        {
          inventoryId: "44444444-4444-4444-8444-444444444444",
          snapshotId: payload.snapshotId,
          snapshotRevision: 1,
          batchId: "batch-1",
          payloadDigest: digest,
          sequenceCeiling: 7,
          resultRevision: 1,
          outcomes: [],
        },
        { batchId: "batch-1", payloadDigest: digest, ...payload },
      ),
    ).toThrow("Invalid inventory event batch response");
  });
});
