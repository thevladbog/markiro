import { describe, expect, it } from "vitest";
import { HttpException } from "@nestjs/common";
import {
  applyOrderLineLimit,
  assertOrderBoxMemberBudget,
  classifyResolvedBoxConflicts,
  reclassifyOrderKmKeyRace,
  type ResolvedOrderBox,
} from "../src/modules/pickup-orders/box-order-resolver";
import { orderRejectedResponse } from "../src/modules/pickup-orders/pickup-orders.service";
import {
  kioskOrderPayloadDigest,
  kioskOrderProcessingLines,
  kioskOrderRequestMarker,
  findSerializedKioskWinner,
} from "../src/modules/pickup-orders/kiosk-admission-proof";

function box(sscc: string, count: number, keys: string[]): ResolvedOrderBox {
  return {
    boxId: `box-${sscc}`,
    sscc,
    productId: "product",
    bottleCount: count,
    unitPrice: "10.00",
    members: keys.map((kmKey, index) => ({
      rawKm: `raw-${index}`,
      kmKey,
      gtin14: "04600682000013",
      serial: `serial-${index}`,
    })),
  };
}

describe("atomic box order resolution", () => {
  it("never splits a box when the employee has less allowance than its bottle count", () => {
    const twelve = box(
      "346006820000000014",
      12,
      Array.from({ length: 12 }, (_, i) => `k${i}`),
    );
    const result = applyOrderLineLimit({
      existingCount: 0,
      dayLimit: 5,
      limited: true,
      loose: [],
      boxes: [twelve],
      looseConflict: () => ({ rawKm: "", reason: "over_limit" }),
    });
    expect(result.acceptedBoxes).toEqual([]);
    expect(result.boxConflicts).toEqual([
      { sscc: twelve.sscc, bottleCount: 12, reason: "over_limit" },
    ]);
  });

  it("accepts the first box and rejects only later overlap without exposing members", () => {
    const first = box("346006820000000014", 2, ["a", "b"]);
    const second = box("346006820000000021", 2, ["b", "c"]);
    expect(classifyResolvedBoxConflicts({ boxes: [first, second], looseKeys: new Set() })).toEqual({
      accepted: [first],
      conflicts: [{ sscc: second.sscc, bottleCount: 2, reason: "duplicate" }],
    });
  });

  it("does not let a loose-rejected box poison a later valid box", () => {
    const rejected = box("346006820000000014", 2, ["loose", "shared"]);
    const accepted = box("346006820000000021", 2, ["shared", "new"]);
    expect(
      classifyResolvedBoxConflicts({ boxes: [rejected, accepted], looseKeys: new Set(["loose"]) }),
    ).toEqual({
      accepted: [accepted],
      conflicts: [{ sscc: rejected.sscc, bottleCount: 2, reason: "duplicate" }],
    });
  });

  it("reclassifies a box-only uniqueness race as one whole-box duplicate", () => {
    const raced = box("346006820000000014", 2, ["a", "b"]);
    expect(
      reclassifyOrderKmKeyRace({
        loose: [],
        requestedBoxes: [{ sscc: raced.sscc }],
        attemptedBoxes: [raced],
        conflictingKeys: new Set(["b"]),
      }),
    ).toEqual({
      loose: [],
      looseConflicts: [],
      requestedBoxes: [],
      boxConflicts: [{ sscc: raced.sscc, bottleCount: 2, reason: "duplicate" }],
    });
  });

  it("pins bounded 413 and all-rejected 422 response payloads", () => {
    expect(() => assertOrderBoxMemberBudget(1_000)).not.toThrow();
    try {
      assertOrderBoxMemberBudget(1_001);
      throw new Error("expected member budget failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(413);
      expect((error as HttpException).getResponse()).toEqual({ code: "box_request_too_large" });
    }
    const boxConflict = {
      sscc: "346006820000000014",
      bottleCount: 12,
      reason: "duplicate" as const,
    };
    expect(orderRejectedResponse({ conflicts: [], boxConflicts: [boxConflict] })).toEqual({
      code: "order_rejected",
      message: "No submitted order lines were accepted",
      conflicts: [],
      boxConflicts: [boxConflict],
      acceptedBoxes: [],
    });
  });

  it("uses one locale-independent vNext order for proof and limit processing", () => {
    const first = {
      deviceSeq: 1,
      badgeCode: "badge",
      reason: "buy" as const,
      items: [{ rawKm: "я" }, { rawKm: "z" }, { rawKm: "a" }],
      boxes: [{ sscc: "346006820000000427" }, { sscc: "346006820000000410" }],
    };
    const reordered = {
      ...first,
      items: first.items.toReversed(),
      boxes: first.boxes.toReversed(),
    };
    expect(kioskOrderProcessingLines(first)).toEqual(kioskOrderProcessingLines(reordered));
    expect(kioskOrderProcessingLines(first)).toEqual({
      items: [{ rawKm: "a" }, { rawKm: "z" }, { rawKm: "я" }],
      boxes: [{ sscc: "346006820000000410" }, { sscc: "346006820000000427" }],
      vNext: true,
    });
    expect(kioskOrderPayloadDigest(first)).toBe(kioskOrderPayloadDigest(reordered));

    const resolvedBySscc = new Map([
      [first.boxes[0]!.sscc, box(first.boxes[0]!.sscc, 4, ["a", "b", "c", "d"])],
      [first.boxes[1]!.sscc, box(first.boxes[1]!.sscc, 4, ["e", "f", "g", "h"])],
    ]);
    const winners = (request: typeof first) => {
      const processing = kioskOrderProcessingLines(request);
      return applyOrderLineLimit({
        existingCount: 1,
        dayLimit: 5,
        limited: true,
        loose: [],
        boxes: processing.boxes.map((line) => resolvedBySscc.get(line.sscc)!),
        looseConflict: () => ({ rawKm: "", reason: "over_limit" }),
      });
    };
    expect(winners(first)).toEqual(winners(reordered));
    expect(winners(first).acceptedBoxes.map((accepted) => accepted.sscc)).toEqual([
      "346006820000000410",
    ]);
  });

  it("marks boxes-empty vNext rejections without inventing a box line", () => {
    expect(kioskOrderRequestMarker({ boxes: [] }, "order_rejected")).toEqual({
      source: "request",
      version: 2,
      terminalReason: "order_rejected",
    });
    expect(kioskOrderRequestMarker({}, "order_rejected")).toBeNull();
  });

  it("checks a serialized order before rejection and stops before mutable resolution", async () => {
    const calls: string[] = [];
    const rejection = { kind: "rejection" };
    await expect(
      findSerializedKioskWinner({
        findOrder: async () => {
          calls.push("order");
          return null;
        },
        findRejection: async () => {
          calls.push("rejection");
          return rejection;
        },
      }),
    ).resolves.toBe(rejection);
    expect(calls).toEqual(["order", "rejection"]);

    calls.length = 0;
    const orderWinner = { kind: "order" };
    await expect(
      findSerializedKioskWinner({
        findOrder: async () => {
          calls.push("order");
          return orderWinner;
        },
        findRejection: async () => {
          calls.push("rejection");
          return rejection;
        },
      }),
    ).resolves.toBe(orderWinner);
    expect(calls).toEqual(["order"]);

    calls.length = 0;
    await expect(
      findSerializedKioskWinner({
        findOrder: async () => {
          calls.push("order");
          return null;
        },
      }),
    ).resolves.toBeNull();
    expect(calls).toEqual(["order"]);
  });
});
