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

// Migration 0195: the offline flag of catalog items and the assignments journal.
describe.skipIf(!databaseUrl)("offline catalog items migration", () => {
  const databaseName = `markiro_offline_catalog_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const planItem = randomUUID();
  const serviceItem = randomUUID();
  const tenant = `offline-cat-${randomUUID()}`;
  const site = randomUUID();
  const legacyIssuance = randomUUID();

  async function issuance(overrides: {
    source: string;
    reason: string;
    assignments: string | null;
  }) {
    return pool.query(
      `INSERT INTO standalone_license_issuances
        (id, tenant_id, site_id, sequence, request_id, host_id, plan, plan_version_id, entitlement_revision,
         payload, compact, sha256, kid, grace_days, issued_at, valid_from, valid_until, source,
         valid_until_reason, source_assignments, issued_by_platform_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7,$8,'{}','x',$9,'k',14,now(),now(),now() + interval '30 days',$10,$11,$12::jsonb,'cat-admin')`,
      [
        randomUUID(),
        tenant,
        site,
        Math.floor(Math.random() * 1_000_000) + 10,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        overrides.source === "offline" ? 0 : 5,
        "a".repeat(64),
        overrides.source,
        overrides.reason,
        overrides.assignments,
      ],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-offline-catalog-migration-"));
    const before = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: before,
      lastIncludedIndex: 194,
    });
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1::uuid,$3,'plan','Тест','Test'),($2::uuid,$4,'service','Услуга','Service')",
      [planItem, serviceItem, `plan-${planItem}`, `service-${serviceItem}`],
    );
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at,cabinet_access) VALUES ($1,'T',$2,now(),'none')",
      [tenant, `slug-${tenant}`],
    );
    await pool.query(
      "INSERT INTO platform_users (id,email,name,role,status,two_factor_enabled) VALUES ('cat-admin','cat@example.invalid','C','platform_admin','active',true)",
    );
    await pool.query(
      `INSERT INTO standalone_sites (id,tenant_id,host_id,name,last_activation_request,host_history,request_id,created_by_platform_user_id)
       VALUES ($1,$2,$3,'Цех','{"format":"x"}','[{"hostId":"x"}]',$4,'cat-admin')`,
      [site, tenant, randomUUID(), randomUUID()],
    );
    await pool.query(
      `INSERT INTO standalone_license_issuances
        (id,tenant_id,site_id,sequence,request_id,host_id,plan,plan_version_id,entitlement_revision,payload,compact,sha256,kid,grace_days,issued_at,valid_from,valid_until,source,valid_until_reason,issued_by_platform_user_id)
       VALUES ($1,$2,$3,1,$4,$5,'subscription',$6,0,'{}','x',$7,'k',14,now(),now(),now() + interval '30 days','offline','offline_term','cat-admin')`,
      [legacyIssuance, tenant, site, randomUUID(), randomUUID(), randomUUID(), "b".repeat(64)],
    );
    const applied = await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(applied.packaged).toContain("0195_offline_catalog_items");
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("leaves every existing item unavailable offline and the old journal rows intact", async () => {
    const items = await pool.query("SELECT offline_available FROM catalog_items");
    expect(
      items.rows.every((row: { offline_available: boolean }) => row.offline_available === false),
    ).toBe(true);
    const old = await pool.query(
      "SELECT source, valid_until_reason, source_assignments FROM standalone_license_issuances WHERE id = $1",
      [legacyIssuance],
    );
    expect(old.rows).toEqual([
      { source: "offline", valid_until_reason: "offline_term", source_assignments: null },
    ]);
  });

  it("allows the flag on plans and add-ons only", async () => {
    await pool.query("UPDATE catalog_items SET offline_available = true WHERE id = $1", [planItem]);
    await expect(
      pool.query("UPDATE catalog_items SET offline_available = true WHERE id = $1", [serviceItem]),
    ).rejects.toThrow(/catalog_items_offline_kind_check/);
  });

  it("accepts an offline_assignments row with its assignments and refuses malformed ones", async () => {
    const assignments = JSON.stringify([
      { kind: "plan", id: randomUUID(), catalogVersionId: randomUUID() },
    ]);
    await expect(
      issuance({ source: "offline_assignments", reason: "one_year_cap", assignments }),
    ).resolves.toBeDefined();
    await expect(
      issuance({ source: "offline_assignments", reason: "offline_term", assignments }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
    await expect(
      issuance({ source: "offline_assignments", reason: "one_year_cap", assignments: null }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
    await expect(
      issuance({ source: "offline_assignments", reason: "one_year_cap", assignments: "[]" }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
    await expect(
      issuance({ source: "subscription", reason: "one_year_cap", assignments }),
    ).rejects.toThrow(/standalone_license_issuances_shape_check/);
  });
});
