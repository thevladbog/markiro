import { getTableName } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

function table(name: string) {
  const candidate = (schema as unknown as Record<string, AnyPgTable | undefined>)[name];
  if (!candidate) throw new Error(`schema.${name} is missing`);
  return candidate;
}

function foreignKey(table: AnyPgTable, name: string) {
  const key = getTableConfig(table).foreignKeys.find((item) => item.getName() === name);
  if (!key) throw new Error(`missing foreign key ${name}`);
  return key.reference();
}

function uniqueColumns(table: AnyPgTable, name: string) {
  const constraint = getTableConfig(table).uniqueConstraints.find(
    (item) => item.getName() === name,
  );
  if (!constraint) throw new Error(`missing unique constraint ${name}`);
  return constraint.columns.map((column) => column.name);
}

describe("shift export persistence schema", () => {
  it("generates the queue and integrity checks into the runtime migration", () => {
    const migration = readFileSync(
      new URL("../migrations/0036_neat_quasar.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      'CREATE INDEX "shift_exports_queued_created_idx" ON "shift_exports" USING btree ("created_at") WHERE "shift_exports"."status" = \'queued\';',
    );
    expect(migration).toContain(
      'CONSTRAINT "shift_exports_max_lines_range" CHECK ("shift_exports"."max_lines" is null or "shift_exports"."max_lines" between 2 and 1000000)',
    );
    expect(migration).toContain(
      'CONSTRAINT "shift_export_artifacts_sha256_check" CHECK ("shift_export_artifacts"."sha256" ~ \'^[0-9a-f]{64}$\')',
    );
    expect(migration).toContain(
      'CONSTRAINT "shift_exports_status_consistency" CHECK (("shift_exports"."status" = \'ready\' and "shift_exports"."completed_at" is not null and "shift_exports"."error_code" is null)',
    );
  });

  it("persists a tenant-scoped export request with its queue state", () => {
    const exports = table("shiftExports");
    const config = getTableConfig(exports);

    expect(getTableName(exports)).toBe("shift_exports");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "id",
        "tenant_id",
        "shift_id",
        "format_id",
        "format_version",
        "max_lines",
        "status",
        "error_code",
        "product_name_snapshot",
        "shift_date_snapshot",
        "total_code_count",
        "total_box_count",
        "created_by_user_id",
        "idempotency_key",
        "source_snapshot_started_at",
        "completed_at",
        "attempt_count",
        "created_at",
        "updated_at",
      ]),
    );
    expect(uniqueColumns(exports, "shift_exports_tenant_id_uq")).toEqual(["tenant_id", "id"]);
    expect(uniqueColumns(exports, "shift_exports_tenant_idempotency_uq")).toEqual([
      "tenant_id",
      "created_by_user_id",
      "idempotency_key",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "shift_exports_format_version_positive",
        "shift_exports_max_lines_range",
        "shift_exports_total_code_count_positive",
        "shift_exports_total_box_count_nonnegative",
        "shift_exports_attempt_count_nonnegative",
        "shift_exports_status_consistency",
      ]),
    );
    expect(config.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        "shift_exports_tenant_shift_created_idx",
        "shift_exports_queued_created_idx",
      ]),
    );

    const shiftReference = foreignKey(exports, "shift_exports_tenant_shift_fk");
    expect(getTableName(shiftReference.foreignTable)).toBe("shifts");
    expect(shiftReference.columns.map((column) => column.name)).toEqual(["tenant_id", "shift_id"]);
    expect(shiftReference.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
  });

  it("persists each export artifact under its tenant-scoped export", () => {
    const artifacts = table("shiftExportArtifacts");
    const config = getTableConfig(artifacts);

    expect(getTableName(artifacts)).toBe("shift_export_artifacts");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "id",
        "tenant_id",
        "export_id",
        "part_number",
        "physical_line_count",
        "code_count",
        "box_count",
        "filename",
        "mime_type",
        "byte_size",
        "sha256",
        "object_key",
        "created_at",
      ]),
    );
    expect(uniqueColumns(artifacts, "shift_export_artifacts_tenant_id_uq")).toEqual([
      "tenant_id",
      "id",
    ]);
    expect(uniqueColumns(artifacts, "shift_export_artifacts_tenant_export_part_uq")).toEqual([
      "tenant_id",
      "export_id",
      "part_number",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "shift_export_artifacts_part_number_positive",
        "shift_export_artifacts_physical_line_count_positive",
        "shift_export_artifacts_code_count_positive",
        "shift_export_artifacts_box_count_nonnegative",
        "shift_export_artifacts_byte_size_positive",
        "shift_export_artifacts_sha256_check",
      ]),
    );

    const exportReference = foreignKey(artifacts, "shift_export_artifacts_tenant_export_fk");
    expect(getTableName(exportReference.foreignTable)).toBe("shift_exports");
    expect(exportReference.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "export_id",
    ]);
    expect(exportReference.foreignColumns.map((column) => column.name)).toEqual([
      "tenant_id",
      "id",
    ]);
  });
});
