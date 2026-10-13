import { describe, expect, it } from "vitest";

import type { OfficeProduct } from "../src/host/protocol.js";
import { productFields, showsEgais, toProductInput } from "../src/office/products/product-form.js";

const BEER: OfficeProduct = {
  id: "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f",
  gtin14: "04607001234562",
  name: "Пиво светлое 0,5 л",
  printName: null,
  chzProductGroupCode: 15,
  boxCapacity: 20,
  palletBoxCapacity: 60,
  shelfLifeDays: 180,
  defaultBoxTemplateId: null,
  defaultPalletTemplateId: null,
  defaultPalletSheetId: null,
  egaisCode: "0150320000001234567",
  defaultCounterpartyId: "0b9e7c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d",
  photoChecksum: null,
  archived: false,
  status: "active",
  rev: 7,
};

describe("the product form's EGAIS code and default counterparty (plan ТОВ)", () => {
  it("shows the EGAIS field only for ЧЗ group 15", () => {
    expect(showsEgais("15")).toBe(true);
    expect(showsEgais("8")).toBe(false);
    expect(showsEgais("")).toBe(false);
  });

  it("carries both fields of a product, and blanks for a new one", () => {
    expect(productFields(BEER)).toMatchObject({
      egaisCode: "0150320000001234567",
      defaultCounterpartyId: "0b9e7c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d",
    });
    expect(productFields(null)).toMatchObject({ egaisCode: "", defaultCounterpartyId: "" });
  });

  it("sends the trimmed code with group 15, none otherwise, and none for a blank one", () => {
    const values = productFields(BEER);
    expect(toProductInput({ ...values, egaisCode: " 0150320000001234567 " })).toMatchObject({
      egaisCode: "0150320000001234567",
      defaultCounterpartyId: "0b9e7c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d",
    });
    expect(toProductInput({ ...values, chzProductGroupCode: "8" }).egaisCode).toBeNull();
    expect(toProductInput({ ...values, egaisCode: "   " }).egaisCode).toBeNull();
    expect(
      toProductInput({ ...values, defaultCounterpartyId: "" }).defaultCounterpartyId,
    ).toBeNull();
  });
});
