import { describe, expect, it } from "vitest";
import { palletLabelFields, type PalletLabelInput } from "../src/index.js";

const base: PalletLabelInput = {
  sscc: "103460068200000004",
  boxCount: 12,
  itemCount: 240,
  productName: "Вода питьевая 0,5 л",
  productPrintName: "Вода 0,5",
  gtin14: "04680089900000",
  egaisCode: null,
  shelfLifeDays: 30,
  operatorName: "Иванов И.",
  counterpartyName: null,
  closedAt: "2026-09-11T07:00:00.000Z",
  productionDate: "2026-09-11",
  shiftNumber: "SEP26-003",
};

describe("palletLabelFields", () => {
  it("prints units in qty and boxes in qty.boxes", () => {
    const fields = palletLabelFields(base);
    expect(fields.qty).toBe("240");
    expect(fields["qty.boxes"]).toBe("12");
  });

  it("prefers the short print name, falling back to the full one", () => {
    expect(palletLabelFields(base)["product.printName"]).toBe("Вода 0,5");
    expect(palletLabelFields({ ...base, productPrintName: null })["product.printName"]).toBe(
      "Вода питьевая 0,5 л",
    );
  });

  it("carries the bare SSCC, never the AI-prefixed form", () => {
    // The (00) application identifier belongs to the emitter and nowhere else.
    expect(palletLabelFields(base).sscc).toBe("103460068200000004");
  });

  it("counts the production day as day one, so expiry is inclusive", () => {
    // 2026-09-11 with 30 days of shelf life is usable through 2026-10-10.
    expect(palletLabelFields(base).date).toBe("11.09.2026");
    expect(palletLabelFields(base).expiry).toBe("10.10.2026");
  });

  it("expires a one-day shelf life on the production day itself", () => {
    expect(palletLabelFields({ ...base, shelfLifeDays: 1 }).expiry).toBe("11.09.2026");
  });

  it("crosses 29 February in a leap year", () => {
    // 28 Feb is day one, 29 Feb day two, 1 Mar day three.
    const leap = { ...base, productionDate: "2028-02-28", shelfLifeDays: 3 };
    expect(palletLabelFields(leap).expiry).toBe("01.03.2028");
  });

  it("takes the declared production day over the closure instant's timezone", () => {
    // Closed just before midnight UTC: without the declared day winning
    // outright, the printed date would drift by one with the runner's zone.
    const declared = {
      ...base,
      closedAt: "2026-09-11T23:30:00.000Z",
      productionDate: "2026-09-10",
    };
    expect(palletLabelFields(declared).date).toBe("10.09.2026");
    expect(palletLabelFields(declared).expiry).toBe("09.10.2026");
  });

  it("leaves the expiry empty when there is no shelf life", () => {
    expect(palletLabelFields({ ...base, shelfLifeDays: null }).expiry).toBe("");
  });

  it("yields empty dates for a declared date that does not exist", () => {
    const fields = palletLabelFields({ ...base, productionDate: "2026-02-30" });
    expect(fields.date).toBe("");
    expect(fields.expiry).toBe("");
  });

  it("prints nothing for the unit code: a pallet is not a unit", () => {
    expect(palletLabelFields(base)["km.code"]).toBe("");
  });

  it("turns absent optionals into empty strings rather than the word null", () => {
    const fields = palletLabelFields({
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
