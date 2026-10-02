import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("exports all draft, approval and retention columns with civil-date retention", () => {
  expect(schema.traceabilityPlanVersions).toBeDefined();
  const table = getTableConfig(schema.traceabilityPlanVersions);
  expect(table.columns.map((column) => column.name)).toEqual([
    "id",
    "tenant_id",
    "version_number",
    "status",
    "draft_revision",
    "schema_version",
    "sections",
    "change_summary",
    "created_by",
    "created_at",
    "updated_at",
    "approved_by",
    "approved_at",
    "config_snapshot",
    "config_digest",
    "approved_evidence",
    "idempotency_key_hash",
    "approval_request_digest",
    "pdf_object_key",
    "pdf_sha256",
    "pdf_byte_size",
    "renderer_version",
    "superseded_by_id",
    "superseded_at",
    "retain_through",
  ]);
  expect(schema.traceabilityPlanVersions.id.primary).toBe(true);
  expect(schema.traceabilityPlanVersions.id.getSQLType()).toBe("uuid");
  expect(schema.traceabilityPlanVersions.sections.getSQLType()).toBe("jsonb");
  expect(schema.traceabilityPlanVersions.configSnapshot.getSQLType()).toBe("jsonb");
  expect(schema.traceabilityPlanVersions.approvedEvidence.getSQLType()).toBe("jsonb");
  expect(schema.traceabilityPlanVersions.retainThrough.getSQLType()).toBe("date");
  expect(schema.traceabilityPlanVersions.retainThrough.dataType).toBe("string");
  for (const name of ["createdAt", "updatedAt", "approvedAt", "supersededAt"] as const) {
    expect(schema.traceabilityPlanVersions[name].getSQLType()).toBe("timestamp with time zone");
  }
});

it("models tenant-safe plan lineage and one draft/effective slot per tenant", () => {
  const table = getTableConfig(schema.traceabilityPlanVersions);
  expect(table.uniqueConstraints.map((key) => key.columns.map((column) => column.name))).toEqual([
    ["tenant_id", "id"],
    ["tenant_id", "version_number"],
  ]);
  const indexes = table.indexes.filter((index) => index.config.unique && index.config.where);
  expect(indexes).toHaveLength(3);
  const dialect = new PgDialect();
  expect(
    indexes.map((index) => ({
      name: index.config.name,
      columns: index.config.columns.map((column) => ("name" in column ? column.name : undefined)),
      predicate: index.config.where && dialect.sqlToQuery(index.config.where).sql,
    })),
  ).toEqual([
    {
      name: "traceability_plan_one_draft_uq",
      columns: ["tenant_id"],
      predicate: '"traceability_plan_versions"."status" = \'draft\'',
    },
    {
      name: "traceability_plan_one_effective_uq",
      columns: ["tenant_id"],
      predicate: '"traceability_plan_versions"."status" = \'effective\'',
    },
    {
      name: "traceability_plan_idempotency_key_uq",
      columns: ["tenant_id", "idempotency_key_hash"],
      predicate: '"traceability_plan_versions"."idempotency_key_hash" is not null',
    },
  ]);
  expect(
    table.foreignKeys.map((key) => {
      const ref = key.reference();
      return [
        ref.foreignTable,
        ref.columns.map((column) => column.name),
        ref.foreignColumns.map((column) => column.name),
      ];
    }),
  ).toEqual([
    [schema.organization, ["tenant_id"], ["id"]],
    [schema.traceabilityPlanVersions, ["tenant_id", "superseded_by_id"], ["tenant_id", "id"]],
  ]);
  for (const key of table.foreignKeys) {
    expect(key.onDelete ?? "no action").toBe("no action");
    expect(key.onUpdate ?? "no action").toBe("no action");
  }
});
