import { describe, expect, it } from "vitest";
import {
  publicApiScopesSchema,
  publicApiKeyCreateSchema,
  publicApiKeyUpdateSchema,
} from "../src/public-api.js";

describe("public API scopes", () => {
  it("accepts only a unique closed set", () => {
    expect(publicApiScopesSchema.safeParse(["inventory.start", "inventory.start"]).success).toBe(
      false,
    );
    expect(
      publicApiKeyCreateSchema.safeParse({ name: "ERP", scopes: ["inventory.prepare"] }).success,
    ).toBe(true);
    expect(publicApiKeyCreateSchema.safeParse({ name: "ERP", scopes: ["*"] }).success).toBe(false);
    expect(publicApiKeyCreateSchema.parse({ name: "Legacy" }).scopes).toEqual([]);
  });
  it("requires a complete update and rejects extra properties", () => {
    expect(publicApiKeyUpdateSchema.safeParse({}).success).toBe(false);
    expect(publicApiKeyUpdateSchema.parse({ scopes: [] })).toEqual({ scopes: [] });
    expect(publicApiKeyUpdateSchema.safeParse({ scopes: [], tenantId: "other" }).success).toBe(
      false,
    );
    expect(publicApiKeyCreateSchema.safeParse({ name: "ERP", enabled: true }).success).toBe(false);
  });
});

it("keeps public wire projections closed and supports incomplete catalog drafts", async () => {
  const { publicProductSchema, publicInventoryStartSchema, publicInventoryResultsSchema } =
    await import("../src/public-api.js");
  const id = "10000000-0000-4000-8000-000000000001";
  expect(
    publicProductSchema.parse({
      id,
      gtin14: "04680089900383",
      name: "Draft",
      status: "draft",
      boxCapacity: null,
    }).boxCapacity,
  ).toBeNull();
  expect(
    publicInventoryStartSchema.safeParse({
      inventoryId: id,
      snapshotId: id,
      status: "running",
      operatorCredentials: [],
    }).success,
  ).toBe(false);
  expect(
    publicInventoryResultsSchema.safeParse({ items: [], nextCursor: null, tenantId: id }).success,
  ).toBe(false);
});
