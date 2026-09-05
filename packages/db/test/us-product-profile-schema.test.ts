import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("US product profile storage", () => {
  it("anchors each profile to its tenant-owned product, not a global product ID", () => {
    const config = getTableConfig(schema.productTraceabilityProfiles);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "product_id",
    ]);
    const reference = config.foreignKeys
      .find((key) => key.getName() === "product_traceability_profiles_tenant_product_fk")
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual(["tenant_id", "product_id"]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    expect(reference?.foreignTable).toBe(schema.products);
  });
});
