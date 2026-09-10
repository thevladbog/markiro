import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "../src/index.js";

function table(name: string) {
  const candidate = (schema as unknown as Record<string, AnyPgTable | undefined>)[name];
  if (!candidate) throw new Error(`schema.${name} is missing`);
  return candidate;
}

describe("platform operational report persistence", () => {
  it("stores durable generation and private artifact state", () => {
    const reports = table("platformReports");
    const config = getTableConfig(reports);

    expect(getTableName(reports)).toBe("platform_reports");
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "id",
        "created_by_platform_user_id",
        "parameters",
        "idempotency_key",
        "status",
        "attempt_count",
        "lease_expires_at",
        "artifact_object_key",
        "artifact_checksum",
        "artifact_byte_size",
        "artifact_filename",
        "snapshot_at",
        "completed_at",
        "expires_at",
        "error_code",
        "row_count",
        "created_at",
        "updated_at",
      ]),
    );
    expect(
      config.uniqueConstraints
        .find((item) => item.getName() === "platform_reports_creator_idempotency_uq")
        ?.columns.map((column) => column.name),
    ).toEqual(["created_by_platform_user_id", "idempotency_key"]);
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "platform_reports_attempt_count_nonnegative",
        "platform_reports_artifact_consistency",
        "platform_reports_completion_consistency",
        "platform_reports_checksum_format",
        "platform_reports_counts_nonnegative",
        "platform_reports_error_consistency",
        "platform_reports_error_code_vocabulary",
        "platform_reports_lease_consistency",
      ]),
    );
    const creator = config.foreignKeys
      .find((key) => key.getName() === "platform_reports_creator_fk")
      ?.reference();
    expect(creator && getTableName(creator.foreignTable)).toBe("platform_users");
  });

  it("links selected tenants without any tenant-user identity foreign key", () => {
    const tenants = table("platformReportTenants");
    const config = getTableConfig(tenants);
    expect(getTableName(tenants)).toBe("platform_report_tenants");
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "report_id",
      "tenant_id",
    ]);
    expect(
      config.foreignKeys.map((key) => getTableName(key.reference().foreignTable)).sort(),
    ).toEqual(["organization", "platform_reports"]);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("platform report migration behavior", () => {
  const suffix = randomUUID();
  const databaseName = `markiro_platform_reports_${suffix.replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const creatorId = `report-admin-${suffix}`;
  let created = false;

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status)
       VALUES ($1, 'Report admin', $2, 'platform_admin', 'active')`,
      [creatorId, `${suffix}@example.invalid`],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
  });

  it("enforces creator, idempotency, lease, and safe error-code invariants", async () => {
    const idempotencyKey = randomUUID();
    const parameters = {
      reportType: "summary",
      tenantIds: ["tenant-a"],
      fromDate: "2026-01-01",
      toDate: "2026-01-01",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "aggregate",
    };

    const insert = `INSERT INTO platform_reports
      (created_by_platform_user_id, parameters, idempotency_key, status, lease_expires_at,
       completed_at, expires_at, error_code)
      VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days', $7)`;

    await expect(
      pool.query(insert, ["missing-creator", parameters, randomUUID(), "queued", null, null, null]),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(insert, [creatorId, parameters, idempotencyKey, "queued", null, null, null]);
    await expect(
      pool.query(insert, [creatorId, parameters, idempotencyKey, "queued", null, null, null]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(insert, [creatorId, parameters, randomUUID(), "processing", null, null, null]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(insert, [
        creatorId,
        parameters,
        randomUUID(),
        "failed",
        null,
        new Date(),
        "REPORT_UNKNOWN_FAILURE",
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(insert, [
        creatorId,
        parameters,
        randomUUID(),
        "failed",
        null,
        new Date(),
        "database password leaked",
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

function quoteIdentifier(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
