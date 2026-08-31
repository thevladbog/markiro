import { readFileSync } from "node:fs";

import { getTableName, is } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
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
    (item) => item.config.name === indexName,
  );
  if (found === undefined) throw new Error(`missing index ${indexName}`);
  return found;
}

function indexColumns(tableName: string, indexName: string): string[] {
  return index(tableName, indexName).config.columns.map((column) =>
    is(column, IndexedColumn) ? (column.name ?? "unnamed") : "expression",
  );
}

function indexWhere(tableName: string, indexName: string): string | undefined {
  const where = index(tableName, indexName).config.where;
  return where === undefined
    ? undefined
    : new PgDialect().sqlToQuery(where).sql.replaceAll(/"[^"]+"\./g, "");
}

function foreignKey(tableName: string, foreignKeyName: string) {
  const found = getTableConfig(table(tableName)).foreignKeys.find(
    (item) => item.getName() === foreignKeyName,
  );
  if (found === undefined) throw new Error(`missing foreign key ${foreignKeyName}`);
  const reference = found.reference();
  return {
    table: getTableName(reference.foreignTable),
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
  };
}

describe("product regulatory schema", () => {
  it("exports the global and tenant regulatory tables", () => {
    expect(
      [
        "nationalCatalogSchemaVersions",
        "nationalCatalogCategoryGroupMappings",
        "nationalCatalogAttributeMappings",
        "productRegulatoryProfiles",
        "productRegulatoryAttributeValues",
        "productEgaisCodes",
        "nationalCatalogCardSnapshots",
        "productRegulatoryProposals",
      ].map((name) => getTableName(table(name))),
    ).toEqual([
      "national_catalog_schema_versions",
      "national_catalog_category_group_mappings",
      "national_catalog_attribute_mappings",
      "product_regulatory_profiles",
      "product_regulatory_attribute_values",
      "product_egais_codes",
      "national_catalog_card_snapshots",
      "product_regulatory_proposals",
    ]);
  });

  it("pins persisted lifecycle and provenance enum values", () => {
    expect(enumValues("nationalCatalogSchemaStatus")).toEqual([
      "observed",
      "validated",
      "active",
      "retired",
    ]);
    expect(enumValues("productAttributeSource")).toEqual([
      "manual",
      "1c",
      "national_catalog",
      "migration",
    ]);
    expect(enumValues("productAttributeState")).toEqual(["active", "inapplicable"]);
    expect(enumValues("productRegulatoryProposalStatus")).toEqual([
      "preview",
      "applied",
      "rejected",
      "stale",
    ]);
  });

  it("allows only one active National Catalog schema per scope", () => {
    const active = index(
      "nationalCatalogSchemaVersions",
      "national_catalog_schema_versions_active_scope_uq",
    );
    expect(active.config.unique).toBe(true);
    expect(
      indexColumns(
        "nationalCatalogSchemaVersions",
        "national_catalog_schema_versions_active_scope_uq",
      ),
    ).toEqual(["scope_key"]);
    expect(
      indexWhere(
        "nationalCatalogSchemaVersions",
        "national_catalog_schema_versions_active_scope_uq",
      ),
    ).toBe("\"status\" = 'active'");
  });

  it("uses tenant-scoped product foreign keys for every product-owned table", () => {
    expect(
      [
        ["productRegulatoryProfiles", "product_regulatory_profiles_tenant_product_fk"],
        [
          "productRegulatoryAttributeValues",
          "product_regulatory_attribute_values_tenant_product_fk",
        ],
        ["productEgaisCodes", "product_egais_codes_tenant_product_fk"],
        ["nationalCatalogCardSnapshots", "national_catalog_card_snapshots_tenant_product_fk"],
        ["productRegulatoryProposals", "product_regulatory_proposals_tenant_product_fk"],
      ].map(([tableName, foreignKeyName]) => foreignKey(tableName!, foreignKeyName!)),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        table: "products",
        columns: ["tenant_id", "product_id"],
        foreignColumns: ["tenant_id", "id"],
      })),
    );
  });

  it("keeps one current attribute value per product and attribute", () => {
    const current = index(
      "productRegulatoryAttributeValues",
      "product_regulatory_attribute_values_current_uq",
    );
    expect(current.config.unique).toBe(true);
    expect(
      indexColumns(
        "productRegulatoryAttributeValues",
        "product_regulatory_attribute_values_current_uq",
      ),
    ).toEqual(["tenant_id", "product_id", "attribute_id"]);
    expect(
      indexWhere(
        "productRegulatoryAttributeValues",
        "product_regulatory_attribute_values_current_uq",
      ),
    ).toBe('"superseded_at" is null');
  });

  it("stores valid AP codes with at most one primary per product", () => {
    const config = getTableConfig(table("productEgaisCodes"));
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "product_id",
      "code",
    ]);
    expect(config.checks.map((check) => check.name)).toContain("product_egais_codes_digits_ck");

    const primary = index("productEgaisCodes", "product_egais_codes_primary_uq");
    expect(primary.config.unique).toBe(true);
    expect(indexColumns("productEgaisCodes", "product_egais_codes_primary_uq")).toEqual([
      "tenant_id",
      "product_id",
    ]);
    expect(indexWhere("productEgaisCodes", "product_egais_codes_primary_uq")).toBe(
      '"is_primary" = true',
    );
  });

  it("backfills only valid legacy AP codes without altering the compatibility field", () => {
    const migration = readFileSync(
      new URL("../migrations/0107_product_regulatory_foundation.sql", import.meta.url),
      "utf8",
    )
      .replaceAll(/\s+/g, " ")
      .trim();

    expect(migration).toContain(
      `INSERT INTO "product_egais_codes" ("tenant_id", "product_id", "code", "is_primary", "source") SELECT "tenant_id", "id", "egais_code", true, 'migration' FROM "products" WHERE "egais_code" ~ '^[0-9]{19}$' ON CONFLICT DO NOTHING;`,
    );
    expect(migration).not.toMatch(/UPDATE\s+"products"/i);
    expect(migration).not.toMatch(/SET\s+"egais_code"/i);
  });
});
