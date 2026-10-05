import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("preserves exact column names, types and tenant unique keys", () => {
  const expected = [
    [
      schema.traceRequests,
      "trace_requests",
      "id tenant_id request_number requester_name requester_organization requester_contact received_at due_at alternate_deadline_reason scope revision status last_validation last_validation_digest last_validated_at warning_ack_digest warning_ack_reason warning_ack_at warning_ack_by created_by closed_at created_at updated_at",
      [
        ["tenant_id", "id"],
        ["tenant_id", "request_number"],
      ],
    ],
    [
      schema.traceExportRuns,
      "trace_export_runs",
      "id tenant_id request_id revision mode status created_by idempotency_key command_digest scoped_content_digest input_snapshot input_digest plan_version_id plan_pdf_sha256 registry_version registry_hash export_ready failure_code started_at generation_started_at report_rendered_at completed_at attempt_count lifecycle_version retry_cycle cycle_attempt_count next_attempt_at lease_attempt_id lease_token lease_expires_at attempt_deadline_at",
      [
        ["tenant_id", "id"],
        ["tenant_id", "request_id", "revision"],
        ["tenant_id", "created_by", "idempotency_key"],
      ],
    ],
    [
      schema.traceExportArtifacts,
      "trace_export_artifacts",
      "id tenant_id run_id kind filename media_type byte_size sha256 object_key published_at",
      [
        ["tenant_id", "id"],
        ["tenant_id", "run_id", "kind"],
        ["tenant_id", "run_id", "filename"],
      ],
    ],
  ] as const;
  for (const [table, name, columns, keys] of expected) {
    const config = getTableConfig(table);
    expect(config.name).toBe(name);
    expect(config.columns.map((c) => c.name)).toEqual(columns.split(" "));
    expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual(keys);
    expect(config.indexes).toHaveLength(1);
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(schema.organization);
    for (const column of config.columns) {
      if (column.name.endsWith("_at")) expect(column.getSQLType()).toBe("timestamp with time zone");
    }
  }
  expect(schema.traceRequests.scope.notNull).toBe(false);
  expect(schema.traceRequests.revision.default).toBe(1);
  expect(schema.traceRequests.status.default).toBe("open");
  expect(schema.traceExportRuns.exportReady.default).toBe(false);
  expect(schema.traceExportRuns.attemptCount.default).toBe(0);
  expect(schema.traceExportArtifacts.byteSize.getSQLType()).toBe("bigint");
});

it("exports request, run and artifact storage with tenant-safe non-cascading references", () => {
  for (const table of [schema.traceRequests, schema.traceExportRuns, schema.traceExportArtifacts]) {
    expect(table).toBeDefined();
    const config = getTableConfig(table);
    expect(config.columns.map((c) => c.name)).toContain("tenant_id");
    expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual([
      "tenant_id",
      "id",
    ]);
    for (const fk of config.foreignKeys) {
      expect(fk.onDelete ?? "no action").toBe("no action");
      expect(fk.onUpdate ?? "no action").toBe("no action");
    }
  }
  expect(
    getTableConfig(schema.traceExportRuns).foreignKeys.map((fk) =>
      fk.reference().columns.map((c) => c.name),
    ),
  ).toEqual([
    ["tenant_id"],
    ["tenant_id", "id", "lease_attempt_id", "lease_token"],
    ["tenant_id", "request_id"],
    ["tenant_id", "plan_version_id"],
  ]);
  expect(
    getTableConfig(schema.traceExportArtifacts).foreignKeys.map((fk) =>
      fk.reference().columns.map((c) => c.name),
    ),
  ).toEqual([["tenant_id"], ["tenant_id", "run_id"]]);
});

it("constrains statuses, evidence, deadlines and artifact kinds", () => {
  const dialect = new PgDialect();
  const checks = [schema.traceRequests, schema.traceExportRuns, schema.traceExportArtifacts].map(
    (table) =>
      getTableConfig(table)
        .checks.map((c) => dialect.sqlToQuery(c.value).sql)
        .join("\n"),
  );
  expect(checks[0]).toContain("interval '24 hours'");
  expect(checks[0]).toContain("'open'");
  expect(checks[1]).toContain("'failed'");
  expect(checks[1]).toContain("selectionKind");
  expect(checks[2]).toContain("'package_zip'");
});
