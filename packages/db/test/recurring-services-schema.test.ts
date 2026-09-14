import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

function table(name: "servicePeriods" | "serviceUsageEntries" | "serviceExcessApprovals") {
  const value = schema[name];
  expect(value, `missing schema export ${name}`).toBeDefined();
  return value as AnyPgTable;
}

describe("recurring service storage schema", () => {
  it("adds nullable service terms without rewriting historical catalog versions", () => {
    const serviceTerms = getTableColumns(schema.catalogItemVersions).serviceTerms;
    expect(serviceTerms).toBeDefined();
    expect(serviceTerms?.notNull).toBe(false);
    expect(serviceTerms?.hasDefault).toBe(false);
  });

  it("exports service periods, usage entries and excess approvals", () => {
    expect(getTableName(table("servicePeriods"))).toBe("service_periods");
    expect(getTableName(table("serviceUsageEntries"))).toBe("service_usage_entries");
    expect(getTableName(table("serviceExcessApprovals"))).toBe("service_excess_approvals");
  });

  it("pins period source facts to the tenant", () => {
    const references = getTableConfig(table("servicePeriods")).foreignKeys.map((key) => ({
      name: key.getName(),
      columns: key
        .reference()
        .columns.map((column) => column.name)
        .join(","),
    }));

    expect(references).toEqual(
      expect.arrayContaining([
        {
          name: "service_periods_tenant_ordered_service_fk",
          columns: "tenant_id,ordered_service_id",
        },
        { name: "service_periods_tenant_invoice_fk", columns: "tenant_id,invoice_id" },
        { name: "service_periods_tenant_invoice_line_fk", columns: "tenant_id,invoice_line_id" },
        {
          name: "service_periods_tenant_payment_fk",
          columns: "tenant_id,invoice_id,payment_id",
        },
      ]),
    );
  });

  it("keeps request identities and append-only relationships tenant scoped", () => {
    for (const name of ["serviceUsageEntries", "serviceExcessApprovals"] as const) {
      const config = getTableConfig(table(name));
      expect(config.uniqueConstraints.map((key) => key.getName())).toEqual(
        expect.arrayContaining([
          `${getTableName(table(name))}_tenant_id_uq`,
          `${getTableName(table(name))}_tenant_request_id_uq`,
        ]),
      );
      expect(
        config.foreignKeys.some(
          (key) =>
            key
              .reference()
              .columns.map((column) => column.name)
              .join(",") === "tenant_id,service_period_id",
        ),
      ).toBe(true);
    }
  });

  it("declares bounds and mutation-shape checks in Drizzle", () => {
    expect(getTableConfig(table("servicePeriods")).checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "service_periods_time_check",
        "service_periods_timezone_check",
        "service_periods_json_check",
        "service_periods_included_minutes_check",
        "service_periods_revision_check",
      ]),
    );
    expect(getTableConfig(table("serviceUsageEntries")).checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "service_usage_entries_shape_check",
        "service_usage_entries_request_hash_check",
        "service_usage_entries_response_check",
      ]),
    );
    expect(getTableConfig(table("serviceExcessApprovals")).checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "service_excess_approvals_shape_check",
        "service_excess_approvals_request_hash_check",
        "service_excess_approvals_response_check",
      ]),
    );
  });
});
