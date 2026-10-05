import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("exports tenant-bound worker evidence with unique attempt numbers and retry commands", () => {
  for (const key of [
    "traceExportAttempts",
    "traceExportRenderCheckpoints",
    "traceExportObjectIntents",
    "traceExportRetryReceipts",
  ] as const) {
    expect(schema).toHaveProperty(key);
    const table = Reflect.get(schema, key);
    const config = getTableConfig(table);
    expect(
      config.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name)),
    ).toContainEqual(["tenant_id", "run_id"]);
  }
});

it("binds checkpoint/object attempts and unique lifetime numbers, keys and retry cycles", () => {
  const config = getTableConfig(schema.traceExportAttempts);
  expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual([
    "tenant_id",
    "run_id",
    "attempt_number",
  ]);
  for (const table of [schema.traceExportRenderCheckpoints, schema.traceExportObjectIntents]) {
    expect(
      getTableConfig(table).foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name)),
    ).toContainEqual(["tenant_id", "run_id", "attempt_id"]);
  }
  expect(
    getTableConfig(schema.traceExportObjectIntents).uniqueConstraints.map((u) =>
      u.columns.map((c) => c.name),
    ),
  ).toContainEqual(["object_key"]);
  const receipts = getTableConfig(schema.traceExportRetryReceipts).uniqueConstraints.map((u) =>
    u.columns.map((c) => c.name),
  );
  expect(receipts).toContainEqual(["tenant_id", "actor_id", "idempotency_key"]);
  expect(receipts).toContainEqual(["tenant_id", "run_id", "cycle"]);
  const checks = getTableConfig(schema.traceExportObjectIntents)
    .checks.map((c) => new PgDialect().sqlToQuery(c.value).sql)
    .join("\n");
  for (const state of ["allocated", "verified", "unresolved", "fenced", "deleted", "referenced"])
    expect(checks).toContain(`'${state}'`);
  for (const table of [
    schema.traceExportAttempts,
    schema.traceExportObjectIntents,
    schema.traceExportRenderCheckpoints,
    schema.traceExportRetryReceipts,
  ])
    for (const fk of getTableConfig(table).foreignKeys) {
      expect(fk.onDelete).toBe("no action");
      expect(fk.onUpdate).toBe("no action");
    }
});

it("keeps old queued defaults and constrains lifetime counters and complete lease identity", () => {
  const run = getTableConfig(schema.traceExportRuns);
  const defaults = Object.fromEntries(run.columns.map((c) => [c.name, c.default]));
  expect(defaults).toMatchObject({ lifecycle_version: 0, retry_cycle: 1, cycle_attempt_count: 0 });
  const checks = run.checks.map((c) => new PgDialect().sqlToQuery(c.value).sql).join("\n");
  expect(checks).toContain('"attempt_count" >= 0');
  expect(checks).toContain('"cycle_attempt_count" BETWEEN 0 AND 3');
  expect(run.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name))).toContainEqual([
    "tenant_id",
    "id",
    "lease_attempt_id",
    "lease_token",
  ]);
});
