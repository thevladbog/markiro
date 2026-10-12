import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { tenantAuditEvents } from "../src/schema/team.js";

it("keeps duplicate audit facts legal with tenant-first action and request access paths", () => {
  const indexes = getTableConfig(tenantAuditEvents).indexes.map(({ config }) => ({
    name: config.name,
    columns: config.columns.map((column) => ("name" in column ? column.name : undefined)),
    unique: config.unique,
    method: config.method,
    where: config.where,
  }));
  expect(indexes).toEqual([
    {
      name: "tenant_audit_events_tenant_created_idx",
      columns: ["organization_id", "created_at"],
      unique: false,
      method: "btree",
      where: undefined,
    },
    {
      name: "tenant_audit_events_tenant_action_idx",
      columns: ["organization_id", "action"],
      unique: false,
      method: "btree",
      where: undefined,
    },
    {
      name: "tenant_audit_events_tenant_request_idx",
      columns: ["organization_id", "request_id"],
      unique: false,
      method: "btree",
      where: undefined,
    },
  ]);
});

it("ships only the two additive nonunique indexes in migration 0143", () => {
  const path = resolve("migrations/0143_us_demo_audit_indexes.sql");
  expect(existsSync(path), "migration 0143 exists").toBe(true);
  const statements = readFileSync(path, "utf8")
    .replaceAll("--> statement-breakpoint", "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  expect(statements).toEqual([
    'CREATE INDEX "tenant_audit_events_tenant_action_idx" ON "tenant_audit_events" USING btree ("organization_id","action")',
    'CREATE INDEX "tenant_audit_events_tenant_request_idx" ON "tenant_audit_events" USING btree ("organization_id","request_id")',
  ]);
});
