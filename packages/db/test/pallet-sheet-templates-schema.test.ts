import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema.js";
describe("pallet sheet storage schema", () => {
  it("adds revision and immutable format beside the untouched JSON model", () => {
    const columns = getTableConfig(schema.labelTemplates).columns;
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["spec", "format", "revision", "seed_key"]),
    );
    expect(columns.find((c) => c.name === "revision")?.default).toBe(1);
  });
  it("keeps sheet defaults and shift snapshots separate from V1", () => {
    expect(getTableConfig(schema.orgProfiles).columns.map((c) => c.name)).toContain(
      "default_pallet_sheet_template_id",
    );
    expect(getTableConfig(schema.shifts).columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["pallet_sheet_template_id", "pallet_sheet_template_snapshot"]),
    );
    expect(schema).toHaveProperty("orgPalletSheetTemplateDefaults");
  });
});
