import { describe, expect, it } from "vitest";
import * as contractPackage from "../src/index.js";
import {
  createUsProductSchema,
  updateUsProductSchema,
  usProductSchema,
} from "../src/traceability/catalog.js";
import type { CreateUsProductInput, UpdateUsProductInput, UsProduct } from "../src/index.js";

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
    expect(contractPackage.updateUsProductSchema).toBe(updateUsProductSchema);
    expect(contractPackage.usProductSchema).toBe(usProductSchema);
  });
});
