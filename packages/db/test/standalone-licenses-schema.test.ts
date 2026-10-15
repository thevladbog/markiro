import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("standalone license schema (plan ЛЦ-0)", () => {
  it("exports the site registry and the issuance journal", () => {
    expect(schema).toHaveProperty("standaloneSites");
    expect(schema).toHaveProperty("standaloneLicenseIssuances");
  });

  it("binds an issuance to its tenant's site by a composite key and orders it per site", () => {
    const issuances = getTableConfig(schema.standaloneLicenseIssuances);
    expect(
      issuances.foreignKeys.some(
        (key) =>
          key.getName() === "standalone_license_issuances_tenant_site_fk" &&
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "tenant_id,site_id",
      ),
    ).toBe(true);
    expect(
      issuances.uniqueConstraints.map((constraint) => [
        constraint.getName(),
        constraint.columns.map((column) => column.name).join(","),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["standalone_license_issuances_site_sequence_uq", "site_id,sequence"],
        ["standalone_license_issuances_tenant_site_request_uq", "tenant_id,site_id,request_id"],
      ]),
    );
    const sites = getTableConfig(schema.standaloneSites);
    expect(
      sites.uniqueConstraints.map((constraint) => [
        constraint.getName(),
        constraint.columns.map((column) => column.name).join(","),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["standalone_sites_host_id_uq", "host_id"],
        ["standalone_sites_tenant_id_uq", "tenant_id,id"],
        ["standalone_sites_tenant_request_uq", "tenant_id,request_id"],
      ]),
    );
  });
});
