import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema.js";

describe("traceability profile persistence boundary", () => {
  it("has a tenant-owned profile table with no implicit RU profile", () => {
    expect(schema).toHaveProperty("traceabilityProfiles");
    const table = schema.traceabilityProfiles;
    expect(table.tenantId.primary).toBe(true);
    expect(table.code.notNull).toBe(true);
    expect(table.code.hasDefault).toBe(false);
    expect(table.retentionYears.default).toBe(5);
    expect(getTableConfig(table).checks.map((check) => check.name)).toEqual([
      "traceability_profiles_baseline_for_us",
      "traceability_profiles_retention_min",
    ]);
    expect(
      getTableConfig(table).foreignKeys.map((fk) => fk.reference().foreignColumns[0]?.name),
    ).toEqual(["id", "id"]);
    expect(schema.orgProfiles.timeZone.default).toBe("Europe/Moscow");
  });
});
