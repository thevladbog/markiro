import { describe, expect, it } from "vitest";
import {
  canonicalKioskOrderContent,
  issueOpaqueKioskAdmissionToken,
  kioskAdmissionTokenHash,
  kioskOrderPayloadDigest,
} from "../src/modules/pickup-orders/kiosk-admission-proof";

const order = {
  deviceSeq: 17,
  badgeCode: "badge-a",
  reason: "buy" as const,
  items: [{ rawKm: "010460704360021721serial" }],
};

describe("durable kiosk order admission", () => {
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
