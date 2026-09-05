import { getTableName, is } from "drizzle-orm";
import { getTableConfig, IndexedColumn, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../src/index.js";

const schemaExports = schema as unknown as Record<string, unknown>;

function table(name: string): AnyPgTable {
  const candidate = schemaExports[name];
  if (candidate === undefined) throw new Error(`schema.${name} is missing`);
  return candidate as AnyPgTable;
}

function enumValues(name: string): string[] {
  const candidate = schemaExports[name] as { enumValues?: string[] } | undefined;
  if (candidate?.enumValues === undefined) throw new Error(`schema.${name} is missing`);
  return candidate.enumValues;
}

function index(tableName: string, indexName: string) {
  const found = getTableConfig(table(tableName)).indexes.find(
    (candidate) => candidate.config.name === indexName,
  );
  if (found === undefined) throw new Error(`missing index ${indexName}`);
  return found;
}

function indexColumns(tableName: string, indexName: string): string[] {
  return index(tableName, indexName).config.columns.map((column) =>
    is(column, IndexedColumn) ? (column.name ?? "unnamed") : "expression",
  );
}

describe("US traceability master-data persistence", () => {
  it("exports the US party and physical-location tables without reusing RU entities", () => {
    expect(
      ["traceabilityParties", "traceabilityLocations"].map((name) => getTableName(table(name))),
    ).toEqual(["traceability_parties", "traceability_locations"]);
    expect(enumValues("traceabilityLocationRole")).toEqual([
      "supplier",
      "processor",
      "ship_from",
      "receive_at",
      "recipient",
      "tlc_source",
    ]);
    expect(enumValues("traceabilityAddressKind")).toEqual(["street", "coordinates"]);
  });

  it("stores exactly the tenant-owned party and location fields", () => {
    expect(
      getTableConfig(table("traceabilityParties")).columns.map((column) => column.name),
    ).toEqual([
      "id",
      "tenant_id",
      "name",
      "legal_name",
      "contact_name",
      "contact_phone",
      "contact_email",
      "notes",
      "archived",
      "created_at",
      "updated_at",
    ]);
    expect(
      getTableConfig(table("traceabilityLocations")).columns.map((column) => column.name),
    ).toEqual([
      "id",
      "tenant_id",
      "party_id",
      "name",
      "business_name",
      "phone_number",
      "address_kind",
      "street_address",
      "latitude",
      "longitude",
      "city",
      "state_or_region",
      "zip_or_postal_code",
      "country_code",
      "roles",
      "archived",
      "created_at",
      "updated_at",
    ]);
  });

  it("makes IDs, archive flags, timestamps, coordinates, and roles persistence-safe", () => {
    const partyColumns = Object.fromEntries(
      getTableConfig(table("traceabilityParties")).columns.map((column) => [column.name, column]),
    );
    const locationColumns = Object.fromEntries(
      getTableConfig(table("traceabilityLocations")).columns.map((column) => [column.name, column]),
    );

    expect(partyColumns.id).toMatchObject({ primary: true, hasDefault: true, notNull: true });
    expect(locationColumns.id).toMatchObject({ primary: true, hasDefault: true, notNull: true });
    expect(partyColumns.archived).toMatchObject({ default: false, notNull: true });
    expect(locationColumns.archived).toMatchObject({ default: false, notNull: true });
    expect(locationColumns.roles).toMatchObject({ default: [], notNull: true });
    expect(locationColumns.latitude?.getSQLType()).toBe("numeric(9, 6)");
    expect(locationColumns.longitude?.getSQLType()).toBe("numeric(9, 6)");
    for (const columns of [partyColumns, locationColumns]) {
      expect(columns.created_at).toMatchObject({ hasDefault: true, notNull: true });
      expect(columns.updated_at).toMatchObject({ hasDefault: true, notNull: true });
    }
  });

  it("enforces tenant-composite identity and party ownership without delete cascades", () => {
    const partyConfig = getTableConfig(table("traceabilityParties"));
    expect(
      partyConfig.uniqueConstraints
        .find((constraint) => constraint.getName() === "traceability_parties_tenant_id_uq")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "id"]);

    const locationConfig = getTableConfig(table("traceabilityLocations"));
    expect(
      locationConfig.uniqueConstraints
        .find((constraint) => constraint.getName() === "traceability_locations_tenant_id_uq")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "id"]);

    const partyKey = locationConfig.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "traceability_locations_tenant_party_fk",
    );
    expect(partyKey?.reference().columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "party_id",
    ]);
    expect(partyKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "tenant_id",
      "id",
    ]);
    expect(partyKey?.onDelete).toBe("no action");
  });

  it("defines active-name, tenant-party, and extension-free roles indexes", () => {
    const activeName = index("traceabilityParties", "traceability_parties_active_name_uq");
    expect(activeName.config.unique).toBe(true);
    expect(indexColumns("traceabilityParties", "traceability_parties_active_name_uq")).toEqual([
      "tenant_id",
      "expression",
    ]);
    expect(activeName.config.where).toBeDefined();

    expect(
      indexColumns("traceabilityLocations", "traceability_locations_tenant_party_idx"),
    ).toEqual(["tenant_id", "party_id"]);
    const roles = index("traceabilityLocations", "traceability_locations_roles_idx");
    expect(roles.config.method).toBe("gin");
    expect(indexColumns("traceabilityLocations", "traceability_locations_roles_idx")).toEqual([
      "roles",
    ]);
  });

  it("declares database checks for names, descriptions, coordinates, countries, and roles", () => {
    expect(
      getTableConfig(table("traceabilityParties")).checks.map((constraint) => constraint.name),
    ).toEqual(["traceability_parties_name_nonempty"]);
    expect(
      getTableConfig(table("traceabilityLocations")).checks.map((constraint) => constraint.name),
    ).toEqual([
      "traceability_locations_name_nonempty",
      "traceability_locations_business_name_nonempty",
      "traceability_locations_country_code_format",
      "traceability_locations_latitude_range",
      "traceability_locations_longitude_range",
      "traceability_locations_address_shape",
      "traceability_locations_roles_shape",
    ]);
  });
});
