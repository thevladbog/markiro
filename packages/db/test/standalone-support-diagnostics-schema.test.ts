import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

const uniques = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).uniqueConstraints.map((constraint) => [
    constraint.getName(),
    constraint.columns.map((column) => column.name).join(","),
  ]);

describe("standalone support diagnostics schema (plan ДИАГ Д1)", () => {
  it("exports the history and the monthly aggregates", () => {
    expect(schema).toHaveProperty("standaloneSupportDiagnostics");
    expect(schema).toHaveProperty("standaloneSupportUsageMonths");
  });

  it("is idempotent by the token hash (global) and by the exact generated instant per host", () => {
    expect(uniques(schema.standaloneSupportDiagnostics)).toEqual(
      expect.arrayContaining([
        ["standalone_support_diagnostics_blob_uq", "blob_sha256"],
        ["standalone_support_diagnostics_host_generated_uq", "tenant_id,host_key,generated_at"],
        ["standalone_support_diagnostics_tenant_id_uq", "tenant_id,id"],
      ]),
    );
  });

  it("binds a site and an aggregate's source by composite tenant keys", () => {
    const history = getTableConfig(schema.standaloneSupportDiagnostics);
    expect(
      history.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_support_diagnostics_tenant_site_fk" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,site_id",
      ),
    ).toBe(true);
    const months = getTableConfig(schema.standaloneSupportUsageMonths);
    expect(
      months.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_support_usage_months_source_fk" &&
          key.onDelete === "cascade" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,source_diagnostic_id",
      ),
    ).toBe(true);
    expect(months.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "host_key",
      "month",
    ]);
  });

  it("reserves a re-made token's hash globally and drops it with its report", () => {
    const aliases = getTableConfig(schema.standaloneSupportTokenAliases);
    expect(aliases.columns.find((column) => column.name === "blob_sha256")?.primary).toBe(true);
    expect(
      aliases.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_support_token_aliases_diagnostic_fk" &&
          key.onDelete === "cascade" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,diagnostic_id",
      ),
    ).toBe(true);
  });

  it("deletes with the tenant", () => {
    for (const table of [
      schema.standaloneSupportDiagnostics,
      schema.standaloneSupportUsageMonths,
      schema.standaloneSupportTokenAliases,
    ]) {
      const tenantFk = getTableConfig(table).foreignKeys.find(
        (key) => key.reference().foreignTable === schema.organization,
      );
      expect(tenantFk?.onDelete).toBe("cascade");
    }
  });
});
