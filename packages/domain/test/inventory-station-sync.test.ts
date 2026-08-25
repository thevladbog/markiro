import { describe, expect, it } from "vitest";

import {
  inventoryEventBatchDigest,
  parseInventoryEventBatch,
  parseInventoryEventBatchResponse,
  parseInventoryProgressPage,
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
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toThrow("Invalid inventory event batch response");
  });

  it.each(["eventId", "operatorId", "snapshotId"] as const)(
    "rejects a non-canonical uppercase %s before digest or identity comparisons",
    (field) => {
      const uppercase =
        field === "snapshotId"
          ? { ...payload, snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() }
          : {
              ...payload,
              events: [{ ...event, [field]: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".toUpperCase() }],
            };
      expect(() => inventoryEventBatchDigest(uppercase)).toThrow(
        "Invalid inventory event batch payload",
      );
    },
  );

  it("binds a semantically complete per-code response to the expected inventory and request", () => {
    const digest = inventoryEventBatchDigest(payload);
    const request = { batchId: "batch-1", payloadDigest: digest, ...payload };
    const response = {
      inventoryId: "44444444-4444-4444-8444-444444444444",
      snapshotId: payload.snapshotId,
      snapshotRevision: 1,
      batchId: "batch-1",
      payloadDigest: digest,
      sequenceCeiling: 7,
      resultRevision: 2,
      outcomes: [
        {
          eventId: event.eventId,
          status: "applied",
          reasonCode: "CLAIM_APPLIED",
          claimedCount: 1,
          conflictCount: 0,
          claims: [
            {
              codeHash: "a".repeat(64),
              status: "claimed",
              winner: {
                codeHash: "a".repeat(64),
                eventId: event.eventId,
                deviceId: "55555555-5555-4555-8555-555555555555",
                scannedAt: event.scannedAt,
              },
            },
          ],
        },
      ],
    };
    expect(
      parseInventoryEventBatchResponse(response, request, "44444444-4444-4444-8444-444444444444"),
    ).toEqual(response);
    expect(() =>
      parseInventoryEventBatchResponse(
        { ...response, inventoryId: "66666666-6666-4666-8666-666666666666" },
        request,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toThrow("Invalid inventory event batch response");
    expect(() =>
      parseInventoryEventBatchResponse(
        {
          ...response,
          outcomes: [
            {
              ...response.outcomes[0],
              claims: [
                {
                  ...response.outcomes[0]!.claims[0],
                  winner: {
                    ...response.outcomes[0]!.claims[0]!.winner,
                    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
                  },
                },
              ],
            },
          ],
        },
        request,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toThrow("Invalid inventory event batch response");
    expect(() =>
      parseInventoryEventBatchResponse(
        {
          ...response,
          outcomes: [
            {
              ...response.outcomes[0],
              claims: [
                {
                  ...response.outcomes[0]!.claims[0],
                  winner: {
                    ...response.outcomes[0]!.claims[0]!.winner,
                    codeHash: "b".repeat(64),
                  },
                },
              ],
            },
          ],
        },
        request,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toThrow("Invalid inventory event batch response");
  });

  it("binds progress to the requested cursor and rejects contradictory winner/revision facts", () => {
    const cursor = "1:77777777-7777-4777-8777-777777777777";
    const item = {
      id: "88888888-8888-4888-8888-888888888888",
      revision: 2,
      kind: "claim",
      codeHash: "a".repeat(64),
      classification: "expected",
      observedProductionDate: "2026-08-20",
      winner: {
        codeHash: "a".repeat(64),
        eventId: "99999999-9999-4999-8999-999999999999",
        deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scannedAt: "2026-08-25T09:00:00.000Z",
      },
      correctedAt: "2026-08-25T10:00:00.000Z",
    } as const;
    const page = {
      inventoryId: "44444444-4444-4444-8444-444444444444",
      snapshotId: payload.snapshotId,
      snapshotRevision: 1,
      cursor,
      resultRevision: 2,
      items: [item],
      nextCursor: `2:${item.id}`,
    };
    const expected = {
      inventoryId: page.inventoryId,
      snapshotId: page.snapshotId,
      cursor,
      minimumResultRevision: 1,
    };
    expect(parseInventoryProgressPage(page, expected)).toEqual(page);
    expect(() => parseInventoryProgressPage({ ...page, cursor: null }, expected)).toThrow(
      "Invalid inventory progress page",
    );
    expect(() =>
      parseInventoryProgressPage(
        {
          ...page,
          items: [{ ...item, winner: { ...item.winner, codeHash: "b".repeat(64) } }],
        },
        expected,
      ),
    ).toThrow("Invalid inventory progress page");
    expect(() => parseInventoryProgressPage({ ...page, resultRevision: 1 }, expected)).toThrow(
      "Invalid inventory progress page",
    );
    expect(() =>
      parseInventoryProgressPage(
        {
          ...page,
          cursor: "1:77777777-7777-4777-8777-77777777777A",
        },
        { ...expected, cursor: "1:77777777-7777-4777-8777-77777777777A" },
      ),
    ).toThrow("Invalid inventory progress page");
  });
});
