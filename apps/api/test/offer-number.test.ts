import { describe, expect, it } from "vitest";

import { nextOfferNumber } from "../src/modules/platform-offers/offer-number";

describe("nextOfferNumber", () => {
  it.each([
    [undefined, "MRK-CO-000001"],
    [null, "MRK-CO-000001"],
    ["MRK-CO-000001", "MRK-CO-000002"],
    ["MRK-CO-000041", "MRK-CO-000042"],
    ["MRK-CO-000009", "MRK-CO-000010"],
    ["MRK-CO-999999", "MRK-CO-1000000"],
  ])("follows %s with %s", (last, next) => {
    expect(nextOfferNumber(last)).toBe(next);
  });

  it("starts a fresh counter after numbers of the previous format", () => {
    expect(nextOfferNumber("KP-2026-000007")).toBe("MRK-CO-000001");
    expect(nextOfferNumber("KP-2026-3F8A12BC")).toBe("MRK-CO-000001");
    expect(nextOfferNumber("MRK-CO-12AB")).toBe("MRK-CO-000001");
  });
});
