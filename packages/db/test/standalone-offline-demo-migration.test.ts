import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Migration 0198: the offline demo file of a tenant without a cabinet (spec 2026-10-20 §4.2).
describe.skipIf(!databaseUrl)("standalone offline demo migration", () => {
  const databaseName = `markiro_offline_demo_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const tenant = `offline-demo-${randomUUID()}`;
  const site = randomUUID();
  const legacy = { offline: randomUUID(), assignments: randomUUID() };
  const refs = JSON.stringify([{ kind: "plan", id: randomUUID(), catalogVersionId: randomUUID() }]);
  let sequence = 10;

  async function issuance(overrides: {
    source: string;
    plan?: string;
    reason: string;
    assignments?: string | null;
    graceDays?: number;
    termDays?: number;
    id?: string;
  }) {
    return pool.query(
      `INSERT INTO standalone_license_issuances
        (id, tenant_id, site_id, sequence, request_id, host_id, plan, plan_version_id, entitlement_revision,
         payload, compact, sha256, kid, grace_days, issued_at, valid_from, valid_until, source,
         valid_until_reason, source_assignments, issued_by_platform_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'{}','x',$9,'k',$10,now(),now(),now() + make_interval(days => $11),$12,$13,$14::jsonb,'demo-admin')`,
      [
        overrides.id ?? randomUUID(),
        tenant,
        site,
        sequence++,
        randomUUID(),
        randomUUID(),
        overrides.plan ?? "demo",
        randomUUID(),
        "a".repeat(64),
        overrides.graceDays ?? 0,
        overrides.termDays ?? 14,
        overrides.source,
        overrides.reason,
        overrides.assignments ?? null,
      ],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-offline-demo-migration-"));
    const before = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: before,
      lastIncludedIndex: 197,
    });
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at,cabinet_access) VALUES ($1,'T',$2,now(),'none')",
      [tenant, `slug-${tenant}`],
    );
    await pool.query(
      "INSERT INTO platform_users (id,email,name,role,status,two_factor_enabled) VALUES ('demo-admin','demo@example.invalid','D','platform_admin','active',true)",
    );
    await pool.query(
      `INSERT INTO standalone_sites (id,tenant_id,host_id,name,last_activation_request,host_history,request_id,created_by_platform_user_id)
       VALUES ($1,$2,$3,'Цех','{"format":"x"}','[{"hostId":"x"}]',$4,'demo-admin')`,
      [site, tenant, randomUUID(), randomUUID()],
    );
    await issuance({
      id: legacy.offline,
      source: "offline",
      plan: "subscription",
      reason: "offline_term",
      graceDays: 14,
      termDays: 30,
    });
    await issuance({
      id: legacy.assignments,
      source: "offline_assignments",
      plan: "subscription",
      reason: "one_year_cap",
      assignments: refs,
      graceDays: 14,
      termDays: 365,
    });
    const applied = await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(applied.packaged).toContain("0198_standalone_offline_demo");
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("keeps the journal rows issued before it", async () => {
    const rows = await pool.query(
      "SELECT id, source, valid_until_reason FROM standalone_license_issuances WHERE id = ANY($1::uuid[]) ORDER BY sequence",
      [[legacy.offline, legacy.assignments]],
    );
    expect(rows.rows).toEqual([
      { id: legacy.offline, source: "offline", valid_until_reason: "offline_term" },
      { id: legacy.assignments, source: "offline_assignments", valid_until_reason: "one_year_cap" },
    ]);
  });

  it("accepts a demo row of 1 to 45 days, with the assignments of the bridge or none", async () => {
    await expect(
      issuance({ source: "offline_demo", reason: "demo_term", termDays: 1 }),
    ).resolves.toBeDefined();
    await expect(
      issuance({ source: "offline_demo", reason: "demo_term", termDays: 45, assignments: refs }),
    ).resolves.toBeDefined();
  });

  it("refuses a demo row that is not a demo plan without grace under the demo term", async () => {
    for (const invalid of [
      { source: "offline_demo", reason: "demo_term", termDays: 46 },
      { source: "offline_demo", reason: "demo_term", plan: "subscription", graceDays: 0 },
      { source: "offline_demo", reason: "demo_term", graceDays: 3 },
      { source: "offline_demo", reason: "offline_term" },
      { source: "offline_demo", reason: "one_year_cap" },
      { source: "offline_demo", reason: "demo_term", assignments: "[]" },
      { source: "subscription", reason: "demo_term" },
      {
        source: "offline_assignments",
        plan: "subscription",
        reason: "demo_term",
        assignments: refs,
        graceDays: 14,
      },
    ])
      await expect(issuance(invalid)).rejects.toThrow(/standalone_license_issuances_shape_check/);
  });
});
