import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("offline catalog items schema (spec 2026-10-16)", () => {
  it("keeps the offline flag on the catalog item, false by default", () => {
    const config = getTableConfig(schema.catalogItems);
    const column = config.columns.find((candidate) => candidate.name === "offline_available");
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(false);
    expect(config.checks.map((check) => check.name)).toContain("catalog_items_offline_kind_check");
    // The flag is deliberately not on versions: published versions are immutable.
    const versions = getTableConfig(schema.catalogItemVersions);
    expect(versions.columns.map((candidate) => candidate.name)).not.toContain("offline_available");
  });

  it("journals the assignments a license was issued from", () => {
    const config = getTableConfig(schema.standaloneLicenseIssuances);
    const column = config.columns.find((candidate) => candidate.name === "source_assignments");
    expect(column?.notNull).toBe(false);
    expect(config.checks.map((check) => check.name)).toContain(
      "standalone_license_issuances_shape_check",
    );
  });
});
