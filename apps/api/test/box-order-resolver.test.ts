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
    const twelve = box("346006820000000014", 12, Array.from({ length: 12 }, (_, i) => `k${i}`));
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

  it("classifies the whole affected box as duplicate without exposing members", () => {
    const first = box("346006820000000014", 2, ["a", "b"]);
    const second = box("346006820000000021", 2, ["b", "c"]);
    expect(
      classifyResolvedBoxConflicts({ boxes: [first, second], looseKeys: new Set(["a"]) }),
    ).toEqual({
      accepted: [],
      conflicts: [
        { sscc: first.sscc, bottleCount: 2, reason: "duplicate" },
        { sscc: second.sscc, bottleCount: 2, reason: "duplicate" },
      ],
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
});
