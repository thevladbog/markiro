import {
  createUsLocationSchema,
  createUsPartySchema,
  createUsProductSchema,
  putProductTraceabilityProfileSchema,
} from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";
import { makeUsDemoReferenceRecipe } from "../src/modules/traceability/demo/us-demo-reference-recipe.js";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references.js";

const partyKeys = [
  "previous_source",
  "processor",
  "recipient",
  "supplier_02",
  "supplier_03",
  "supplier_04",
  "supplier_05",
  "supplier_06",
  "supplier_07",
  "supplier_08",
  "supplier_09",
  "supplier_10",
  "recipient_02",
  "recipient_03",
  "recipient_04",
  "recipient_05",
  "recipient_06",
  "recipient_07",
  "recipient_08",
  "recipient_09",
  "recipient_10",
  "recipient_11",
  "recipient_12",
];
const productKeys = [
  "inbound",
  "output",
  "inbound_02",
  "inbound_03",
  "inbound_04",
  "inbound_05",
  "inbound_06",
  "inbound_07",
  "inbound_08",
  "output_02",
  "output_03",
  "output_04",
  "output_05",
  "output_06",
  "output_07",
  "output_08",
];
const variants = [
  ["02", "Gala"],
  ["03", "Fuji"],
  ["04", "Granny Smith"],
  ["05", "Honeycrisp"],
  ["06", "Golden Delicious"],
  ["07", "Pink Lady"],
  ["08", "Braeburn"],
] as const;
const suppliers = ["02", "03", "04", "05", "06", "07", "08", "09", "10"];
const recipients = ["02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

describe("six-month synthetic reference catalogue", () => {
  it("provides the complete ordered unique key sets for chain reference resolution", () => {
    const catalogue = makeUsSixMonthCatalogue();
    expect(catalogue.parties.map(({ key }) => key)).toEqual(partyKeys);
    expect(catalogue.locations.map(({ key }) => key)).toEqual(partyKeys);
    expect(catalogue.products.map(({ key }) => key)).toEqual(productKeys);
    expect(new Set(catalogue.parties.map(({ key }) => key)).size).toBe(23);
    expect(new Set(catalogue.locations.map(({ key }) => key)).size).toBe(23);
    expect(new Set(catalogue.products.map(({ key }) => key)).size).toBe(16);
  });

  it("preserves every compact reference input and profile unchanged", () => {
    const compact = makeUsDemoReferenceRecipe();
    const catalogue = makeUsSixMonthCatalogue();
    for (const item of compact.parties)
      expect(catalogue.parties.find(({ key }) => key === item.key)).toEqual(item);
    for (const item of compact.locations)
      expect(catalogue.locations.find(({ key }) => key === item.key)).toEqual(item);
    for (const item of compact.products)
      expect(catalogue.products.find(({ key }) => key === item.key)).toEqual(item);
  });

  it("resolves fictional supplier and recipient addresses, roles and 555 phones", () => {
    const catalogue = makeUsSixMonthCatalogue();
    for (const [kind, ordinals, stem, phonePrefix, street, city, zip, roles] of [
      [
        "supplier",
        suppliers,
        "Orchard Supply",
        "509",
        "Example Orchard Rd",
        "Yakima",
        "98901",
        ["supplier", "tlc_source"],
      ],
      [
        "recipient",
        recipients,
        "Market Distribution",
        "206",
        "Example Harbor Ave",
        "Seattle",
        "98134",
        ["recipient"],
      ],
    ] as const) {
      for (const ordinal of ordinals) {
        const key = `${kind}_${ordinal}`;
        const name = `Example ${stem} ${ordinal} LLC`;
        const phone = `+1 ${phonePrefix}-555-01${ordinal}`;
        expect(catalogue.parties.find((item) => item.key === key)?.input).toEqual({
          name,
          legalName: name,
          contactPhone: phone,
          contactName: null,
          contactEmail: null,
          notes: null,
        });
        expect(catalogue.locations.find((item) => item.key === key)).toEqual({
          key,
          partyKey: key,
          input: {
            name,
            businessName: name,
            phoneNumber: phone,
            addressKind: "street",
            streetAddress: `${ordinal}00 ${street}`,
            city,
            stateOrRegion: "WA",
            zipOrPostalCode: zip,
            countryCode: "US",
            latitude: null,
            longitude: null,
            roles,
          },
        });
      }
    }
    for (const location of catalogue.locations) {
      expect(catalogue.parties.some(({ key }) => key === location.partyKey)).toBe(true);
      expect(location.input.countryCode).toBe("US");
    }
  });

  it("provides all seven paired varieties with compact packaging and synthetic review", () => {
    const catalogue = makeUsSixMonthCatalogue();
    for (const [ordinal, variety] of variants) {
      for (const [
        kind,
        suffix,
        brandName,
        packagingSizeValue,
        packagingSizeUom,
        packagingStyle,
        defaultQuantityUom,
      ] of [
        ["inbound", "Slices", "Orchard Slice", "10", "lb", "bag", "lb"],
        ["output", "Snack Cups", "North River", "6", "oz", "cup, 24 cups/case", "case"],
      ] as const) {
        const name = `Fresh-Cut ${variety} Apple ${suffix}`;
        expect(catalogue.products.find(({ key }) => key === `${kind}_${ordinal}`)).toEqual({
          key: `${kind}_${ordinal}`,
          input: { name, gtin: null },
          profile: {
            expectedRevision: 0,
            productName: name,
            brandName,
            commodity: "Apples",
            variety,
            packagingSizeValue,
            packagingSizeUom,
            packagingStyle,
            defaultQuantityUom,
            coverageStatus: "covered",
            coverageRationale:
              "Synthetic demo manual review of a fresh-cut fruit fixture; not an operational assessment.",
            ftlCategory: "Fruits (fresh-cut)",
            ftlSourceUrl:
              "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
            ftlSourceVersion: "markiro-us-synthetic-ftl-review-v1",
          },
        });
      }
    }
  });

  it("exports validated DTOs with null metadata and no runtime or credential values", () => {
    const catalogue = makeUsSixMonthCatalogue();
    for (const party of catalogue.parties) {
      expect(createUsPartySchema.parse(party.input)).toEqual(party.input);
      expect(party.input.contactName).toBeNull();
      expect(party.input.contactEmail).toBeNull();
    }
    for (const location of catalogue.locations) {
      const input = { ...location.input, partyId: "11111111-1111-4111-8111-111111111111" };
      expect(createUsLocationSchema.parse(input)).toEqual(input);
      expect(location.input.latitude).toBeNull();
      expect(location.input.longitude).toBeNull();
      expect(location.input).not.toHaveProperty("partyId");
    }
    for (const product of catalogue.products) {
      expect(createUsProductSchema.parse(product.input)).toEqual(product.input);
      expect(putProductTraceabilityProfileSchema.parse(product.profile)).toEqual(product.profile);
    }
    expect(JSON.stringify(catalogue)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|password|token|cookie|mfa|authorization|privateKey|approvedAt|reviewedAt|createdAt|updatedAt|receivedAt|dueAt|storageKey|tenantId|productId|operationKey/i,
    );
  });

  it("owns fresh recursively frozen JSON on every call", () => {
    const first = makeUsSixMonthCatalogue();
    const second = makeUsSixMonthCatalogue();
    expect(first).toEqual(second);
    const inspect = (left: unknown, right: unknown): void => {
      if (left === null || typeof left !== "object") return;
      expect(Object.isFrozen(left)).toBe(true);
      expect(left).not.toBe(right);
      if (right === null || typeof right !== "object") throw new Error("ownership mismatch");
      const rightChildren = Object.values(right);
      Object.values(left).forEach((child, index) => inspect(child, rightChildren[index]));
    };
    inspect(first, second);
    const location = first.locations[3];
    if (!location) throw new Error("missing supplier location");
    expect(Reflect.set(location.input, "city", "changed")).toBe(false);
    expect(() => location.input.roles.push("processor")).toThrow(TypeError);
    expect(makeUsSixMonthCatalogue()).toEqual(second);
    const compact = makeUsDemoReferenceRecipe();
    compact.locations[0]?.input.roles.push("processor");
    expect(makeUsSixMonthCatalogue()).toEqual(second);
  });
});
