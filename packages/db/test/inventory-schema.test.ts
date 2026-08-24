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

function constraintColumns(tableName: string, constraintName: string): string[] {
  const constraint = getTableConfig(table(tableName)).uniqueConstraints.find(
    (item) => item.getName() === constraintName,
  );
  if (constraint === undefined) throw new Error(`missing unique constraint ${constraintName}`);
  return constraint.columns.map((column) => column.name);
}

function foreignKeyColumns(
  tableName: string,
  foreignKeyName: string,
): { columns: string[]; foreignColumns: string[]; foreignTable: string } {
  const foreignKey = getTableConfig(table(tableName)).foreignKeys.find(
    (item) => item.getName() === foreignKeyName,
  );
  if (foreignKey === undefined) throw new Error(`missing foreign key ${foreignKeyName}`);
  const reference = foreignKey.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    foreignTable: getTableName(reference.foreignTable),
  };
}

function indexColumns(tableName: string, indexName: string): string[] {
  const found = getTableConfig(table(tableName)).indexes.find(
    (item) => item.config.name === indexName,
  );
  if (found === undefined) throw new Error(`missing index ${indexName}`);
  return found.config.columns.map((column) =>
    is(column, IndexedColumn) ? (column.name ?? "unnamed") : "expression",
  );
}

describe("inventory preparation schema", () => {
  it("exports the five preparation tables", () => {
    expect(
      [
        "inventories",
        "inventoryImports",
        "inventorySnapshots",
        "inventorySnapshotInputs",
        "inventorySnapshotCodes",
      ].map((name) => getTableName(table(name))),
    ).toEqual([
      "inventories",
      "inventory_imports",
      "inventory_snapshots",
      "inventory_snapshot_inputs",
      "inventory_snapshot_codes",
    ]);
  });

  it("uses only the six approved Chestny ZNAK statuses", () => {
    expect(enumValues("inventoryChzStatusEnum")).toEqual([
      "EMITTED",
      "INTRODUCED",
      "APPLIED",
      "RETIRED",
      "WRITTEN_OFF",
      "DISAGGREGATION",
    ]);
    expect(enumValues("inventoryChzStatusEnum")).not.toContain("MOVING_BY_UD");
  });

  it("pins the lifecycle, mode, container, and parse-outcome values", () => {
    expect(enumValues("inventoryLifecycleStatusEnum")).toEqual([
      "draft",
      "preparing",
      "ready",
      "running",
      "closed",
      "completed",
    ]);
    expect(enumValues("inventoryModeEnum")).toEqual(["check", "repack"]);
    expect(enumValues("inventoryImportContainerKindEnum")).toEqual(["csv", "zip", "xlsx"]);
    expect(enumValues("inventoryImportParseOutcomeEnum")).toEqual(["succeeded", "failed"]);
  });

  it("tenant-scopes every inventory-owned relation, including the active snapshot", () => {
    expect(foreignKeyColumns("inventories", "inventories_tenant_product_fk")).toEqual({
      columns: ["tenant_id", "product_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "products",
    });
    expect(foreignKeyColumns("inventories", "inventories_tenant_line_fk")).toEqual({
      columns: ["tenant_id", "line_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "lines",
    });
    expect(foreignKeyColumns("inventories", "inventories_tenant_box_label_template_fk")).toEqual({
      columns: ["tenant_id", "box_label_template_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "label_templates",
    });
    expect(foreignKeyColumns("inventories", "inventories_tenant_active_snapshot_fk")).toEqual({
      columns: ["tenant_id", "active_snapshot_id", "id"],
      foreignColumns: ["tenant_id", "id", "inventory_id"],
      foreignTable: "inventory_snapshots",
    });
    expect(foreignKeyColumns("inventoryImports", "inventory_imports_tenant_inventory_fk")).toEqual({
      columns: ["tenant_id", "inventory_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "inventories",
    });
    expect(
      foreignKeyColumns("inventorySnapshots", "inventory_snapshots_tenant_inventory_fk"),
    ).toEqual({
      columns: ["tenant_id", "inventory_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "inventories",
    });
    expect(
      foreignKeyColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_snapshot_inventory_fk",
      ),
    ).toEqual({
      columns: ["tenant_id", "snapshot_id", "inventory_id"],
      foreignColumns: ["tenant_id", "id", "inventory_id"],
      foreignTable: "inventory_snapshots",
    });
    expect(
      foreignKeyColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_import_inventory_status_fk",
      ),
    ).toEqual({
      columns: ["tenant_id", "import_id", "inventory_id", "status"],
      foreignColumns: ["tenant_id", "id", "inventory_id", "declared_status"],
      foreignTable: "inventory_imports",
    });
    expect(
      foreignKeyColumns("inventorySnapshotCodes", "inventory_snapshot_codes_tenant_snapshot_fk"),
    ).toEqual({
      columns: ["tenant_id", "snapshot_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "inventory_snapshots",
    });
  });

  it("permits only one immutable snapshot and one selected import per status", () => {
    expect(
      constraintColumns("inventorySnapshots", "inventory_snapshots_tenant_inventory_uq"),
    ).toEqual(["tenant_id", "inventory_id"]);
    expect(
      constraintColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_snapshot_status_uq",
      ),
    ).toEqual(["tenant_id", "snapshot_id", "status"]);
    expect(
      constraintColumns("inventorySnapshotCodes", "inventory_snapshot_codes_tenant_hash_uq"),
    ).toEqual(["tenant_id", "snapshot_id", "code_hash"]);
  });

  it("declares date, digest, count, lifecycle, mode, and classification checks", () => {
    const checks = [
      ...getTableConfig(table("inventories")).checks,
      ...getTableConfig(table("inventoryImports")).checks,
      ...getTableConfig(table("inventorySnapshots")).checks,
      ...getTableConfig(table("inventorySnapshotCodes")).checks,
    ].map((item) => item.name);

    expect(checks).toEqual(
      expect.arrayContaining([
        "inventories_production_date_order_check",
        "inventories_result_revision_nonnegative_check",
        "inventories_mode_template_check",
        "inventories_active_snapshot_lifecycle_check",
        "inventory_imports_byte_size_nonnegative_check",
        "inventory_imports_sha256_check",
        "inventory_imports_counts_nonnegative_check",
        "inventory_imports_parse_outcome_check",
        "inventory_snapshots_revision_positive_check",
        "inventory_snapshots_combined_digest_check",
        "inventory_snapshots_counts_nonnegative_check",
        "inventory_snapshot_codes_hash_check",
        "inventory_snapshot_codes_gtin14_check",
        "inventory_snapshot_codes_parent_sscc_check",
        "inventory_snapshot_codes_classification_check",
      ]),
    );
  });

  it("indexes inventory listing, import selection, package expansion, and expected dates", () => {
    expect(indexColumns("inventories", "inventories_tenant_status_dates_idx")).toEqual([
      "tenant_id",
      "status",
      "production_date_from",
      "production_date_to",
    ]);
    expect(
      indexColumns("inventoryImports", "inventory_imports_inventory_status_created_idx"),
    ).toEqual(["tenant_id", "inventory_id", "declared_status", "created_at"]);
    expect(
      indexColumns("inventorySnapshotCodes", "inventory_snapshot_codes_parent_sscc_idx"),
    ).toEqual(["snapshot_id", "parent_sscc"]);
    expect(
      indexColumns("inventorySnapshotCodes", "inventory_snapshot_codes_expected_date_idx"),
    ).toEqual(["snapshot_id", "expected", "source_production_date"]);
  });
});
