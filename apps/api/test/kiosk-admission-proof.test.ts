import { describe, expect, it } from "vitest";
import {
  canonicalKioskOrderContent,
  issueOpaqueKioskAdmissionToken,
  kioskAdmissionTokenHash,
  kioskOrderPayloadDigest,
} from "../src/modules/pickup-orders/kiosk-admission-proof";
import { admissionSequenceWithinWindow } from "../src/modules/pickup-orders/kiosk-admission-proof";
import {
  createOrderAdmissionSchema,
  createOrderSchema,
} from "../src/modules/pickup-orders/dto";
import { buildSscc } from "@markiro/domain";

const order = {
  deviceSeq: 17,
  badgeCode: "badge-a",
  reason: "buy" as const,
  items: [{ rawKm: "010460704360021721serial" }],
};
const ssccA = buildSscc(3, "4600682", 41);
const ssccB = buildSscc(3, "4600682", 42);

describe("durable kiosk order admission", () => {
  it("bounds outstanding proofs without requiring dense device sequences", () => {
    expect(
      admissionSequenceWithinWindow({ maxDurableSeq: 10, outstandingCount: 2, candidate: 13 }),
    ).toBe(true);
    expect(
      admissionSequenceWithinWindow({ maxDurableSeq: 10, outstandingCount: 2, candidate: 10_000 }),
    ).toBe(true);
    for (let candidate = 1; candidate <= 129; candidate += 1) {
      expect(
        admissionSequenceWithinWindow({
          maxDurableSeq: candidate - 1,
          outstandingCount: 0,
          candidate,
        }),
      ).toBe(true);
    }
    expect(
      admissionSequenceWithinWindow({ maxDurableSeq: 10, outstandingCount: 127, candidate: 11 }),
    ).toBe(true);
    expect(
      admissionSequenceWithinWindow({ maxDurableSeq: 10, outstandingCount: 128, candidate: 11 }),
    ).toBe(false);
  });
  it("binds the digest to normalized business content and device sequence", () => {
    expect(canonicalKioskOrderContent(order)).toEqual({
      deviceSeq: 17,
      badgeDigest: null,
      badgeCode: "badge-a",
      reason: "buy",
      writeoffReasonId: null,
      items: [{ rawKm: "010460704360021721serial" }],
    });
    expect(kioskOrderPayloadDigest(order)).toHaveLength(64);
    expect(kioskOrderPayloadDigest({ ...order, deviceSeq: 18 })).not.toBe(
      kioskOrderPayloadDigest(order),
    );
    expect(kioskOrderPayloadDigest({ ...order, reason: "writeoff" })).not.toBe(
      kioskOrderPayloadDigest(order),
    );
    expect(kioskOrderPayloadDigest({ ...order, items: [{ rawKm: "different-content" }] })).not.toBe(
      kioskOrderPayloadDigest(order),
    );
    expect(kioskOrderPayloadDigest(order)).toBe(
      "2817e3f27914b23bce65957cc9f37983a2f781c63870c333e7e428c4be52bf02",
    );
  });

  it("keeps legacy proof bytes but canonically sorts vNext copies", () => {
    const items = [{ rawKm: "z" }, { rawKm: "a" }];
    const boxes = [{ sscc: ssccB }, { sscc: ssccA }];
    const legacy = { ...order, items };
    const vNext = { ...legacy, boxes };

    expect(canonicalKioskOrderContent(legacy)).toEqual({
      deviceSeq: 17,
      badgeDigest: null,
      badgeCode: "badge-a",
      reason: "buy",
      writeoffReasonId: null,
      items,
    });
    expect(canonicalKioskOrderContent(vNext)).toEqual({
      deviceSeq: 17,
      badgeDigest: null,
      badgeCode: "badge-a",
      reason: "buy",
      writeoffReasonId: null,
      items: [{ rawKm: "a" }, { rawKm: "z" }],
      boxes: [{ sscc: ssccA }, { sscc: ssccB }],
    });
    expect(items).toEqual([{ rawKm: "z" }, { rawKm: "a" }]);
    expect(boxes).toEqual([{ sscc: ssccB }, { sscc: ssccA }]);
  });

  it("requires at least one unique canonical loose item or box", () => {
    const base = { deviceSeq: 1, badgeCode: "badge", reason: "buy" as const };
    expect(createOrderSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(
      createOrderSchema.safeParse({ ...base, items: [], boxes: [{ sscc: ssccA }] }).success,
    ).toBe(true);
    expect(
      createOrderAdmissionSchema.safeParse({
        ...base,
        items: [{ rawKm: "one" }],
        boxes: [],
      }).success,
    ).toBe(true);
    expect(
      createOrderSchema.safeParse({
        ...base,
        items: [],
        boxes: [{ sscc: ssccA }, { sscc: ssccA }],
      }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({
        ...base,
        items: [],
        boxes: [{ sscc: `00${ssccA}` }],
      }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({
        ...base,
        items: [{ rawKm: "ж".repeat(600) }],
      }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({
        ...base,
        items: [],
        boxes: [{ sscc: ssccA, bottleCount: 12 }],
      }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({
        ...base,
        items: [],
        boxes: [{ sscc: ssccA, members: ["secret"] }],
      }).success,
    ).toBe(false);
  });

  it("issues opaque high-entropy tokens and exposes only deterministic hashes for persistence", () => {
    const first = issueOpaqueKioskAdmissionToken();
    const second = issueOpaqueKioskAdmissionToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(kioskAdmissionTokenHash(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(kioskAdmissionTokenHash(first)).toBe(kioskAdmissionTokenHash(first));
    expect(kioskAdmissionTokenHash(second)).not.toBe(kioskAdmissionTokenHash(first));
  });
});
