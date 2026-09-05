import { describe, expect, it } from "vitest";
import * as contractPackage from "../src/index.js";
import {
  createUsProductSchema,
  listUsProductsQuerySchema,
  updateUsProductSchema,
  usProductListSchema,
  usProductSchema,
} from "../src/traceability/catalog.js";
import type {
  CreateUsProductInput,
  ListUsProductsQuery,
  UpdateUsProductInput,
  UsProduct,
  UsProductList,
} from "../src/index.js";

const productId = "123e4567-e89b-12d3-a456-426614174000";
const timestamps = {
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:01+00:00",
};
const product = {
  id: productId,
  name: "Synthetic cereal",
  gtin14: "00000096385074",
  archived: false,
  ...timestamps,
} satisfies UsProduct;

const createInput = { name: "Synthetic cereal", gtin: "96385074" } satisfies CreateUsProductInput;
const updateInput = { gtin: null, archived: false } satisfies UpdateUsProductInput;
void createInput;
void updateInput;
const listQuery = {
  archived: "all",
  search: "cereal",
  limit: 25,
  offset: 50,
} satisfies ListUsProductsQuery;
const productList = { items: [product], limit: 25, offset: 50 } satisfies UsProductList;
void listQuery;
void productList;

describe("US catalog create contract", () => {
  it("trims a bounded name and defaults an omitted GTIN to null", () => {
    expect(createUsProductSchema.parse({ name: "  Synthetic cereal  " })).toEqual({
      name: "Synthetic cereal",
      gtin: null,
    });
    expect(createUsProductSchema.parse({ name: "x".repeat(200), gtin: null })).toEqual({
      name: "x".repeat(200),
      gtin: null,
    });
  });

  it.each(["96385074", "036000291452", "4006381333931", "10012345678902"])(
    "accepts and preserves valid raw GTIN %s",
    (gtin) => {
      expect(createUsProductSchema.parse({ name: "Synthetic cereal", gtin })).toEqual({
        name: "Synthetic cereal",
        gtin,
      });
    },
  );

  it.each([
    { name: "" },
    { name: "   " },
    { name: "x".repeat(201) },
    { name: null },
    { name: "Synthetic", gtin: 96385074 },
    { name: "Synthetic", gtin: "" },
    { name: "Synthetic", gtin: " 96385074" },
    { name: "Synthetic", gtin: "96385074 " },
    { name: "Synthetic", gtin: "96385075" },
    { name: "Synthetic", gtin: "1234567" },
    { name: "Synthetic", gtin: "96385O74" },
  ])("rejects invalid create data %j", (input) => {
    expect(createUsProductSchema.safeParse(input).success).toBe(false);
  });
});

describe("US catalog update contract", () => {
  it("preserves omission, explicit null and meaningful false without create defaults", () => {
    expect(updateUsProductSchema.parse({ name: "  Renamed  " })).toEqual({ name: "Renamed" });
    expect(updateUsProductSchema.parse({ gtin: null })).toEqual({ gtin: null });
    expect(updateUsProductSchema.parse({ archived: false })).toEqual({ archived: false });
    expect(updateUsProductSchema.parse({ name: "Renamed" })).not.toHaveProperty("gtin");
  });

  it.each([
    {},
    { name: undefined },
    { gtin: undefined },
    { archived: undefined },
    { name: null },
    { archived: null },
    { name: "   " },
    { gtin: 96385074 },
    { gtin: "96385074 " },
    { gtin: "96385075" },
  ])("rejects empty or invalid patch data %j", (input) => {
    expect(updateUsProductSchema.safeParse(input).success).toBe(false);
  });
});

describe("US catalog response contract", () => {
  it("requires the complete persisted representation", () => {
    expect(usProductSchema.parse(product)).toEqual(product);
    for (const key of Object.keys(product)) {
      expect(usProductSchema.safeParse({ ...product, [key]: undefined }).success).toBe(false);
    }
  });

  it("trims bounded response names and validates canonical identity and timestamps", () => {
    expect(usProductSchema.parse({ ...product, name: "  Synthetic cereal  " }).name).toBe(
      "Synthetic cereal",
    );
    for (const override of [
      { id: "not-a-uuid" },
      { name: " " },
      { name: "x".repeat(201) },
      { gtin14: "96385074" },
      { gtin14: "10012345678903" },
      { createdAt: "2026-09-05" },
      { updatedAt: "2026-09-05T00:00:01" },
      { archived: null },
    ]) {
      expect(usProductSchema.safeParse({ ...product, ...override }).success).toBe(false);
    }
    expect(usProductSchema.parse({ ...product, gtin14: null }).gtin14).toBeNull();
  });
});

describe("US catalog list contracts", () => {
  it("uses canonical strict list parsing with bounded defaults", () => {
    expect(listUsProductsQuerySchema.parse({})).toEqual({
      archived: "false",
      limit: 50,
      offset: 0,
    });
    expect(
      listUsProductsQuerySchema.parse({
        archived: "all",
        search: "  cereal  ",
        limit: "100",
        offset: "100000",
      }),
    ).toEqual({ archived: "all", search: "cereal", limit: 100, offset: 100000 });
  });

  it.each([
    { forged: "field" },
    { archived: true },
    { archived: "yes" },
    { search: "x".repeat(201) },
    { limit: 0 },
    { limit: 101 },
    { limit: "01" },
    { offset: -1 },
    { offset: 100001 },
    { offset: "1.5" },
  ])("rejects invalid list query %j", (input) => {
    expect(listUsProductsQuerySchema.safeParse(input).success).toBe(false);
  });

  it("requires a strict bounded response whose item count does not exceed limit", () => {
    expect(usProductListSchema.parse({ items: [product], limit: 1, offset: 0 })).toEqual({
      items: [product],
      limit: 1,
      offset: 0,
    });
    expect(
      usProductListSchema.safeParse({ items: [product], limit: 1, offset: 0, extra: true }).success,
    ).toBe(false);
    expect(usProductListSchema.safeParse({ items: [product], limit: 0, offset: 0 }).success).toBe(
      false,
    );
    expect(
      usProductListSchema.safeParse({ items: [product, product], limit: 1, offset: 0 }).success,
    ).toBe(false);
  });
});

describe("US catalog boundary and public exports", () => {
  const unsupportedFields = [
    "tenantId",
    "profileCode",
    "status",
    "chzProductGroupCode",
    "capacities",
  ] as const;

  it.each(unsupportedFields)("rejects unsupported field %s in every schema", (field) => {
    expect(
      createUsProductSchema.safeParse({ name: "Synthetic", [field]: "unsupported" }).success,
    ).toBe(false);
    expect(
      updateUsProductSchema.safeParse({ archived: false, [field]: "unsupported" }).success,
    ).toBe(false);
    expect(usProductSchema.safeParse({ ...product, [field]: "unsupported" }).success).toBe(false);
  });

  it("exports all catalog schemas from the public package entry", () => {
    expect(contractPackage.createUsProductSchema).toBe(createUsProductSchema);
    expect(contractPackage.listUsProductsQuerySchema).toBe(listUsProductsQuerySchema);
    expect(contractPackage.updateUsProductSchema).toBe(updateUsProductSchema);
    expect(contractPackage.usProductListSchema).toBe(usProductListSchema);
    expect(contractPackage.usProductSchema).toBe(usProductSchema);
  });
});
