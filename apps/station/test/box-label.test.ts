import { describe, expect, it } from "vitest";

import { boxLabelFields, expiryIsoDate } from "../src/lib/box-label.js";

describe("expiryIsoDate", () => {
  it("matches the mock-up: 2025-05-20 + 184 days = 2025-11-20", () => {
    expect(expiryIsoDate("2025-05-20T10:15:00.000Z", 184)).toBe("2025-11-20");
  });

  it("rolls over year and leap-day boundaries", () => {
    expect(expiryIsoDate("2026-12-31T00:00:00.000Z", 1)).toBe("2027-01-01");
    expect(expiryIsoDate("2024-02-28T00:00:00.000Z", 1)).toBe("2024-02-29");
  });

  it("returns empty for null, non-positive, or invalid input", () => {
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", null)).toBe("");
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", 0)).toBe("");
    expect(expiryIsoDate("2025-05-20T00:00:00.000Z", -5)).toBe("");
    expect(expiryIsoDate("garbage", 10)).toBe("");
  });
});

describe("boxLabelFields — egais/expiry", () => {
  const base = {
    sscc: "346006820000000014",
    itemCount: 24,
    productName: "Сидр",
    gtin14: "04600682000013",
    operatorName: null,
    counterpartyName: null,
    closedAt: "2025-05-20T10:15:00.000Z",
    shiftNumber: null,
  };

  it("fills product.egais and computed expiry", () => {
    const fields = boxLabelFields({
      ...base,
      egaisCode: "0101234567890123456",
      shelfLifeDays: 184,
    });
    expect(fields["product.egais"]).toBe("0101234567890123456");
    expect(fields.expiry).toBe("2025-11-20");
  });

  it("degrades to empty strings when the product carries neither", () => {
    const fields = boxLabelFields({ ...base, egaisCode: null, shelfLifeDays: null });
    expect(fields["product.egais"]).toBe("");
    expect(fields.expiry).toBe("");
  });
});
