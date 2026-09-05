import { UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { requireProductGtin } from "../src/modules/products/require-product-gtin";

describe("requireProductGtin", () => {
  it("preserves a present canonical GTIN", () => {
    expect(requireProductGtin("10012345678902")).toBe("10012345678902");
  });

  it("rejects a missing GTIN with the legacy-boundary response", () => {
    expect(() => requireProductGtin(null)).toThrowError(UnprocessableEntityException);
    try {
      requireProductGtin(null);
      throw new Error("expected GTIN_REQUIRED");
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      if (error instanceof UnprocessableEntityException) {
        expect(error.getStatus()).toBe(422);
        expect(error.getResponse()).toEqual({ code: "GTIN_REQUIRED" });
      }
    }
  });
});
