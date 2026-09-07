import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";
describe("lot storage tenant anchors", () => {
  it("stores a positive internal receiving basis version independently of business revision", () => {
    const config = getTableConfig(schema.traceabilityLots);
    const version = config.columns.find((column) => column.name === "receiving_basis_version");
    expect(version).toMatchObject({ notNull: true, default: 1, dataType: "number" });
    expect(config.checks.map((check) => check.name)).toContain(
      "traceability_lots_receiving_basis_version_positive",
    );
  });
  it("keeps correction reason and the server-only source lock nullable for existing lots", () => {
    const config = getTableConfig(schema.traceabilityLots);
    expect(schema.traceabilityLots.lastSourceReason.notNull).toBe(false);
    expect(schema.traceabilityLots.sourceLockedAt.notNull).toBe(false);
    expect(config.checks.map((check) => check.name)).toContain(
      "traceability_lots_source_reason_length",
    );
  });
  it("anchors product and both source forms to their tenant", () => {
    const config = getTableConfig(schema.traceabilityLots);
    for (const [name, column, table] of [
      ["traceability_lots_product_fk", "product_id", schema.products],
      ["traceability_lots_source_location_fk", "source_location_id", schema.traceabilityLocations],
      [
        "traceability_lots_reference_location_fk",
        "source_reference_location_id",
        schema.traceabilityLocations,
      ],
    ] as const) {
      const reference = config.foreignKeys.find((key) => key.getName() === name)?.reference();
      expect(reference?.columns.map((field) => field.name)).toEqual(["tenant_id", column]);
      expect(reference?.foreignColumns.map((field) => field.name)).toEqual(["tenant_id", "id"]);
      expect(reference?.foreignTable).toBe(table);
    }
    expect(
      config.uniqueConstraints.some(
        (key) => key.columns.map((field) => field.name).join(",") === "tenant_id,id",
      ),
    ).toBe(true);
  });
});
