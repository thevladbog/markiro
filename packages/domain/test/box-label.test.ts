import { describe, expect, it } from "vitest";
import {
  boxLabelFields,
  effectiveProductionIsoDate,
  expiryIsoDate,
  localIsoDate,
  type BoxLabelInput,
} from "../src/index.js";

const base: BoxLabelInput = {
  sscc: "046800899000000000",
  itemCount: 20,
  productName: "Вода питьевая 0,5 л",
  productPrintName: null,
  gtin14: "04680089900000",
  egaisCode: null,
  shelfLifeDays: 365,
  operatorName: "Иванов И.",
  counterpartyName: null,
  closedAt: "2026-09-10T08:00:00.000Z",
  productionDate: "2026-09-10",
  shiftNumber: "SEP26-003",
};

describe("boxLabelFields", () => {
  it("counts the production day as day one", () => {
    // 2026-09-10 plus 365 days of shelf life is usable through 2027-09-09, not -10.
    expect(expiryIsoDate("2026-09-10T08:00:00.000Z", 365, "2026-09-10")).toBe("2027-09-09");
  });

  it("expires a one-day shelf life on the production day itself", () => {
    expect(expiryIsoDate("2026-09-10T08:00:00.000Z", 1, "2026-09-10")).toBe("2026-09-10");
  });

  it("prints dates as DD.MM.YYYY and the SSCC bare", () => {
    const fields = boxLabelFields(base);
    expect(fields.date).toBe("10.09.2026");
    expect(fields.expiry).toBe("09.09.2027");
    // The (00) application identifier belongs to the emitter and nowhere else.
    expect(fields.sscc).toBe("046800899000000000");
    expect(fields.qty).toBe("20");
  });

  it("falls back to the full product name when there is no print name", () => {
    expect(boxLabelFields(base)["product.printName"]).toBe("Вода питьевая 0,5 л");
  });

  it("uses the local close date when no production date was declared", () => {
    expect(effectiveProductionIsoDate("2026-09-10T08:00:00.000Z", null)).toBe(
      localIsoDate("2026-09-10T08:00:00.000Z"),
    );
  });

  it("leaves the expiry empty when there is no shelf life", () => {
    expect(boxLabelFields({ ...base, shelfLifeDays: null }).expiry).toBe("");
  });

  it("crosses a leap day without losing one", () => {
    expect(expiryIsoDate("2028-02-29T08:00:00.000Z", 366, "2028-02-29")).toBe("2029-02-28");
  });

  it("yields empty dates for a declared date that does not exist", () => {
    const fields = boxLabelFields({ ...base, productionDate: "2026-02-30" });
    expect(fields.date).toBe("");
    expect(fields.expiry).toBe("");
  });

  it("leaves the box-count field empty: a box holds no boxes", () => {
    expect(boxLabelFields(base)["qty.boxes"]).toBe("");
    expect(boxLabelFields(base).qty).toBe("20");
  });

  it("turns absent optionals into empty strings rather than the word null", () => {
    const fields = boxLabelFields({
      ...base,
      operatorName: null,
      counterpartyName: null,
      shiftNumber: null,
      egaisCode: null,
    });
    expect(fields.operator).toBe("");
    expect(fields["counterparty.name"]).toBe("");
    expect(fields["shift.no"]).toBe("");
    expect(fields["product.egais"]).toBe("");
  });
});
