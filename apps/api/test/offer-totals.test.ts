import { describe, expect, it } from "vitest";
import { calculateOfferTotals } from "../src/modules/platform-offers/offer-totals";

describe("calculateOfferTotals", () => {
  it("calculates exact RUB totals and VAT without floating point", () => {
    expect(
      calculateOfferTotals([
        { quantity: 2, unitPrice: "15000.00", vatRateBps: 2000, vatIncluded: true },
        { quantity: 1, unitPrice: "5000.50", vatRateBps: null, vatIncluded: false },
      ]),
    ).toEqual({ total: "35000.50", currency: "RUB" });
  });

  it("rejects malformed or unsafe decimal amounts", () => {
    expect(() =>
      calculateOfferTotals([
        { quantity: 1, unitPrice: "0.001", vatRateBps: null, vatIncluded: false },
      ]),
    ).toThrow();
    expect(() =>
      calculateOfferTotals([
        { quantity: 0, unitPrice: "1.00", vatRateBps: null, vatIncluded: false },
      ]),
    ).toThrow();
  });
});
