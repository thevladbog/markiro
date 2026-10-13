import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixturePool } from "./support/close-pool.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("standalone license tables on a fresh database (plan ЛЦ-0)", () => {
  const name = `markiro_lc0_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  const siteA = randomUUID();
  const hostA = randomUUID();

  async function site(
    tenant: string,
    id = randomUUID(),
    host = randomUUID(),
    inn: string | null = "7707083893",
  ) {
    await pool.query(
      `INSERT INTO standalone_sites (id, tenant_id, host_id, name, request_inn, last_activation_request, host_history, request_id, created_by_platform_user_id)
       VALUES ($1, $2, $3, 'Цех', $4, '{"format":"markiro-activation-request-v1"}', '[{"hostId":"x"}]', $5, 'lc0-admin')`,
      [id, tenant, host, inn, randomUUID()],
    );
    return id;
  }

  async function issuance(
    overrides: {
      tenant?: string;
      site?: string;
      sequence?: number;
      plan?: string;
      grace?: number;
      sha?: string;
      source?: string;
      reason?: string;
      days?: number;
      issuedSkewSeconds?: number;
    } = {},
  ) {
    return pool.query(
      `INSERT INTO standalone_license_issuances (id, tenant_id, site_id, sequence, request_id, host_id, plan, plan_version_id, entitlement_revision, payload, compact, sha256, kid, grace_days, issued_at, valid_from, valid_until, valid_until_reason, source, issued_by_platform_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 7, '{"version":1}', 'h.p.s', $9, 'lic-1', $10, now() - make_interval(secs => $14), now(), now() + make_interval(days => $13), $11, $12, 'lc0-admin')`,
      [
        randomUUID(),
        overrides.tenant ?? "lc0-a",
        overrides.site ?? siteA,
        overrides.sequence ?? 1,
        randomUUID(),
        hostA,
        overrides.plan ?? "subscription",
        randomUUID(),
        overrides.sha ?? "a".repeat(64),
        overrides.grace ?? 14,
        overrides.reason ?? "subscription_end",
        overrides.source ?? "subscription",
        overrides.days ?? 30,
        overrides.issuedSkewSeconds ?? 0,
      ],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('lc0-a', 'A', 'lc0-a', now()), ('lc0-b', 'B', 'lc0-b', now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id, email, name, role, status, two_factor_enabled) VALUES ('lc0-admin', 'lc0@example.invalid', 'LC0', 'platform_admin', 'active', true)",
    );
    await site("lc0-a", siteA, hostA);
  }, 180_000);

  afterAll(async () => {
    await closeFixturePool(pool);
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
  });

  it("keeps one site per host across tenants and a valid request INN", async () => {
    await expect(site("lc0-b", randomUUID(), hostA)).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_sites_host_id_uq",
    });
    await expect(site("lc0-a", randomUUID(), randomUUID(), "7707")).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_sites_request_inn_check",
    });
  });

  it("orders issuances per site, refuses another tenant's site and a demo with grace days", async () => {
    await issuance();
    await expect(issuance()).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_license_issuances_site_sequence_uq",
    });
    await expect(issuance({ tenant: "lc0-b", sequence: 2 })).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_license_issuances_tenant_site_fk",
    });
    await expect(issuance({ sequence: 3, plan: "demo", grace: 3 })).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_license_issuances_shape_check",
    });
    await expect(issuance({ sequence: 4, sha: "XYZ" })).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_license_issuances_shape_check",
    });
    await expect(issuance({ sequence: 0 })).rejects.toMatchObject({ code: "23514" });
    await issuance({ sequence: 2, plan: "demo", grace: 0 });
    const { rows } = await pool.query(
      "SELECT sequence FROM standalone_license_issuances WHERE site_id = $1 ORDER BY sequence",
      [siteA],
    );
    expect(rows).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("ties an offline issuance to its own term reason, a paid plan and at most a year", async () => {
    await issuance({ sequence: 10, source: "offline", reason: "offline_term", days: 365 });
    for (const invalid of [
      { sequence: 11, source: "offline", reason: "subscription_end" },
      { sequence: 12, source: "subscription", reason: "offline_term" },
      { sequence: 13, source: "offline", reason: "offline_term", plan: "demo", grace: 0 },
      { sequence: 14, source: "cloud" },
    ]) {
      await expect(issuance(invalid)).rejects.toMatchObject({
        code: "23514",
        constraint: "standalone_license_issuances_shape_check",
      });
    }
    await expect(
      issuance({ sequence: 15, source: "offline", reason: "offline_term", days: 366 }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_license_issuances_interval_check",
    });
    await expect(issuance({ sequence: 16, issuedSkewSeconds: 1 })).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_license_issuances_interval_check",
    });
  });
});
