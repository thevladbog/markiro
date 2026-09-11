import { describe, expect, it } from "vitest";
import { calculateOfferBreakdown } from "../src/modules/platform-offers/offer-preview-model";

describe("new offer issue VAT breakdown", () => {
  it.each([
    ["120.00", true, 1, "20.00", "100.00", "20.00", "120.00"],
    ["100.00", false, 1, "20.00", "100.00", "20.00", "120.00"],
    ["0.03", true, 1, "20.00", "0.02", "0.01", "0.03"],
    ["100.00", false, 3, "20.00", "300.00", "60.00", "360.00"],
    ["12.35", true, 2, null, "24.70", "0.00", "24.70"],
  ])(
    "breaks down %s inclusive=%s quantity=%s",
    (agreedUnitPrice, vatIncluded, quantity, vatRate, subtotal, vatTotal, total) => {
      expect(
        calculateOfferBreakdown([{ agreedUnitPrice, vatIncluded, quantity, vatRate }], total),
      ).toEqual({ subtotal, vatTotal, total, lineTotals: [total] });
    },
  );
  it("adds mixed VAT lines and rejects an inconsistent authoritative total", () => {
    const lines = [
      { agreedUnitPrice: "120.00", vatIncluded: true, quantity: 1, vatRate: "20.00" },
      { agreedUnitPrice: "10.00", vatIncluded: false, quantity: 2, vatRate: null },
    ];
    expect(calculateOfferBreakdown(lines, "140.00")).toEqual({
      subtotal: "120.00",
      vatTotal: "20.00",
      total: "140.00",
      lineTotals: ["120.00", "20.00"],
    });
    expect(() => calculateOfferBreakdown(lines, "120.00")).toThrow(
      expect.objectContaining({ response: { code: "offer_total_inconsistent" } }),
    );
  });
  it("uses the persisted commercial money range in previews", () => {
    expect(() =>
      calculateOfferBreakdown(
        [{ agreedUnitPrice: "1000000000000.00", quantity: 1, vatRate: null, vatIncluded: false }],
        "1000000000000.00",
      ),
    ).toThrow(expect.objectContaining({ response: { code: "commercial_amount_out_of_range" } }));
  });
  it.each(["90071992547409.92", "1e2", "-1.00", "1.001"])(
    "rejects unsafe money %s",
    (agreedUnitPrice) => {
      expect(() =>
        calculateOfferBreakdown(
          [{ agreedUnitPrice, quantity: 1, vatRate: null, vatIncluded: true }],
          "0.00",
        ),
      ).toThrow();
    },
  );
});
