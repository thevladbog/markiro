import { describe, expect, it } from "vitest";
import {
  calculateOfferTotals,
  calculateOfferAmounts,
} from "../src/modules/platform-offers/offer-totals";

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

it("retains half-up offer totals and a consistent VAT breakdown on fractional kopecks", () => {
  expect(
    calculateOfferAmounts([
      { quantity: 1, unitPrice: "0.03", vatRateBps: 2000, vatIncluded: true },
      { quantity: 1, unitPrice: "0.03", vatRateBps: 2000, vatIncluded: false },
    ]),
  ).toEqual({
    subtotal: "0.05",
    vatTotal: "0.02",
    total: "0.07",
    currency: "RUB",
    lines: [
      { lineSubtotal: "0.02", lineVat: "0.01", lineTotal: "0.03" },
      { lineSubtotal: "0.03", lineVat: "0.01", lineTotal: "0.04" },
    ],
  });
});

it("calculates intermediate VAT products beyond safe integer range without losing a kopeck", () => {
  expect(
    calculateOfferAmounts([
      { quantity: 1, unitPrice: "999999999999.99", vatRateBps: 10000, vatIncluded: true },
    ]),
  ).toMatchObject({
    subtotal: "499999999999.99",
    vatTotal: "500000000000.00",
    total: "999999999999.99",
  });
  expect(() =>
    calculateOfferAmounts([
      { quantity: 1, unitPrice: "999999999999.99", vatRateBps: 10000, vatIncluded: false },
    ]),
  ).toThrow("Bad Request Exception");
});

it.each(
  [
    [{ quantity: 2, unitPrice: "999999999999.99", vatRateBps: null, vatIncluded: false }],
    [{ quantity: 1, unitPrice: "999999999999.99", vatRateBps: 2000, vatIncluded: false }],
    [
      { quantity: 1, unitPrice: "500000000000.00", vatRateBps: null, vatIncluded: false },
      { quantity: 1, unitPrice: "500000000000.00", vatRateBps: null, vatIncluded: false },
    ],
  ].map((lines) => ({ lines })),
)("rejects storage-range overflow with a business 400: $lines", ({ lines }) => {
  expect(() => calculateOfferAmounts(lines)).toThrowError(
    expect.objectContaining({
      status: 400,
      response: { code: "commercial_amount_out_of_range" },
    }),
  );
});
