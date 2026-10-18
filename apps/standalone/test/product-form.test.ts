import { describe, expect, it } from "vitest";

import type { OfficeProduct } from "../src/host/protocol.js";
import {
  egaisPrintsOnSheet,
  productFields,
  productFieldsSchema,
  showsEgais,
  toProductInput,
} from "../src/office/products/product-form.js";

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

  it("checks the code only while it shows: a hidden overlong code never blocks a save", () => {
    const values = productFields(BEER);
    const long = "1".repeat(65);
    expect(productFieldsSchema.safeParse({ ...values, egaisCode: long }).success).toBe(false);
    expect(
      productFieldsSchema.safeParse({ ...values, egaisCode: long, chzProductGroupCode: "8" })
        .success,
    ).toBe(true);
    expect(productFieldsSchema.safeParse({ ...values, egaisCode: "01\u0007" }).success).toBe(false);
  });

  it("says whether a code prints on an A4 pallet sheet: 19 digits or none", () => {
    expect(egaisPrintsOnSheet("0150320000001234567")).toBe(true);
    expect(egaisPrintsOnSheet(" 0150320000001234567 ")).toBe(true);
    expect(egaisPrintsOnSheet("")).toBe(true);
    expect(egaisPrintsOnSheet("015032000000123456")).toBe(false);
    expect(egaisPrintsOnSheet("EG-0150320000001234")).toBe(false);
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

describe("an archived product is not checked for GTIN (owner's rule)", () => {
  const WRONG = "04607001234561";

  it("checks the GTIN of a product in use, whole", () => {
    const values = { ...productFields(BEER), gtin14: WRONG };
    const checked = productFieldsSchema.safeParse(values);
    expect(checked.success).toBe(false);
    expect(productFieldsSchema.safeParse({ ...values, gtin14: "12" }).success).toBe(false);
  });

  it("lets an archived product keep a wrong or odd GTIN: no check digit, no shape error", () => {
    const archived = { ...productFields(BEER), archived: true };
    expect(productFieldsSchema.safeParse({ ...archived, gtin14: WRONG }).success).toBe(true);
    expect(productFieldsSchema.safeParse({ ...archived, gtin14: "12" }).success).toBe(true);
    expect(productFieldsSchema.safeParse({ ...archived, gtin14: "" }).success).toBe(true);
  });

  it("sends an archived product's GTIN as stored, without the check digit throwing", () => {
    const archived = { ...productFields(BEER), archived: true };
    expect(toProductInput({ ...archived, gtin14: WRONG }).gtin14).toBe(WRONG);
    // Digits short of 14 are zero-padded, as the host keeps 14.
    expect(toProductInput({ ...archived, gtin14: " 4607001234561 " }).gtin14).toBe(WRONG);
    // Anything else goes as typed: the host answers on the field.
    expect(toProductInput({ ...archived, gtin14: "46O7" }).gtin14).toBe("46O7");
  });

  it("still normalizes a valid GTIN of a product in use and throws on a wrong one", () => {
    const values = productFields(BEER);
    expect(toProductInput({ ...values, gtin14: "4607001234562" }).gtin14).toBe("04607001234562");
    expect(() => toProductInput({ ...values, gtin14: WRONG })).toThrow();
  });
});
