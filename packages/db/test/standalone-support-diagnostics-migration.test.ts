import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeFixturePool } from "./support/close-pool.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("standalone support diagnostics tables (plan ДИАГ Д1)", () => {
  const name = `markiro_diag_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  const scratch = mkdtempSync(join(tmpdir(), "diag-migrations-"));
  const siteA = randomUUID();
  const hostA = randomUUID();
  const HASH = (n: number) => n.toString(16).padStart(64, "0");

  async function diagnostic(
    overrides: {
      id?: string;
      tenant?: string;
      site?: string | null;
      hostKey?: string;
      hash?: string;
      generatedAt?: string;
      version?: number;
      role?: string | null;
    } = {},
  ) {
    const id = overrides.id ?? randomUUID();
    await pool.query(
      `INSERT INTO standalone_support_diagnostics
         (id, tenant_id, site_id, host_key, blob_sha256, kid, payload_version, generated_at,
          received_by_platform_user_id, pc_role, devices_station, devices_office, devices_handheld, payload)
       VALUES ($1, $2, $3, $4, $5, 'sup-1', $6, $7, 'diag-admin', $8, 1, 1, 0, '{"v":2}')`,
      [
        id,
        overrides.tenant ?? "diag-a",
        overrides.site === undefined ? siteA : overrides.site,
        overrides.hostKey ?? hostA,
        overrides.hash ?? HASH(1),
        overrides.version ?? 2,
        overrides.generatedAt ?? "2026-10-14T09:00:00Z",
        overrides.role === undefined ? "host" : overrides.role,
      ],
    );
    return id;
  }

  async function month(tenant: string, hostKey: string, key: string, source: string) {
    await pool.query(
      `INSERT INTO standalone_support_usage_months (tenant_id, host_key, month, stats, source_diagnostic_id, source_generated_at)
       VALUES ($1, $2, $3, '{"month":"2026-10"}', $4, '2026-10-14T09:00:00Z')`,
      [tenant, hostKey, key, source],
    );
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    // Update from 0193: apply every migration but the last, then the real folder.
    cpSync(migrationsFolder, scratch, { recursive: true });
    const journalPath = join(scratch, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const diagnosticsIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0194_standalone_support_diagnostics",
    );
    expect(diagnosticsIndex).toBeGreaterThanOrEqual(0);
    journal.entries.splice(diagnosticsIndex);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: scratch });
    const before = await pool.query("SELECT to_regclass('standalone_support_diagnostics') AS t");
    expect(before.rows[0]).toEqual({ t: null });
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('diag-a', 'A', 'diag-a', now()), ('diag-b', 'B', 'diag-b', now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id, email, name, role, status, two_factor_enabled) VALUES ('diag-admin', 'diag@example.invalid', 'DIAG', 'platform_admin', 'active', true)",
    );
    await pool.query(
      `INSERT INTO standalone_sites (id, tenant_id, host_id, name, last_activation_request, host_history, request_id, created_by_platform_user_id)
       VALUES ($1, 'diag-a', $2, 'Цех', '{}', '[{"hostId":"x"}]', $3, 'diag-admin')`,
      [siteA, hostA, randomUUID()],
    );
  }, 180_000);

  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await closeFixturePool(pool);
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
  });

  it("keeps a token once, globally, and a host's exact generated instant once per tenant", async () => {
    await diagnostic({ hash: HASH(1) });
    await expect(diagnostic({ hash: HASH(1), tenant: "diag-b", site: null })).rejects.toMatchObject(
      { code: "23505", constraint: "standalone_support_diagnostics_blob_uq" },
    );
    await expect(diagnostic({ hash: HASH(2) })).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_support_diagnostics_host_generated_uq",
    });
    await diagnostic({ hash: HASH(3), generatedAt: "2026-10-14T09:00:01Z" });
    await diagnostic({ hash: HASH(4), tenant: "diag-b", site: null });
  });

  it("refuses another tenant's site and malformed keys, versions and roles", async () => {
    await expect(
      diagnostic({ hash: HASH(5), tenant: "diag-b", generatedAt: "2026-10-15T09:00:00Z" }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_support_diagnostics_tenant_site_fk",
    });
    const bad = [
      { hash: HASH(6), hostKey: "Host-1", c: "standalone_support_diagnostics_host_key_check" },
      { hash: "XYZ", c: "standalone_support_diagnostics_blob_check" },
      { hash: HASH(7), version: 3, c: "standalone_support_diagnostics_version_check" },
      { hash: HASH(8), role: "kiosk", c: "standalone_support_diagnostics_role_check" },
    ];
    for (const { c, ...overrides } of bad) {
      await expect(
        diagnostic({ ...overrides, generatedAt: "2026-10-16T09:00:00Z" }),
      ).rejects.toMatchObject({ code: "23514", constraint: c });
    }
    await diagnostic({
      hash: HASH(9),
      hostKey: "unknown",
      site: null,
      version: 1,
      role: null,
      generatedAt: "2026-10-17T09:00:00Z",
    });
  });

  it("keys the months by tenant, host and month, with a same-tenant source", async () => {
    const source = await diagnostic({ hash: HASH(10), generatedAt: "2026-10-18T09:00:00Z" });
    await month("diag-a", hostA, "2026-10", source);
    await expect(month("diag-a", hostA, "2026-10", source)).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_support_usage_months_pkey",
    });
    await expect(month("diag-b", hostA, "2026-10", source)).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_support_usage_months_source_fk",
    });
    await expect(month("diag-a", hostA, "2026-13", source)).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_support_usage_months_month_check",
    });
  });

  it("reserves a hash once, only for a same-tenant report, and drops it with the report", async () => {
    const source = await diagnostic({ hash: HASH(13), generatedAt: "2026-10-21T09:00:00Z" });
    const alias = (hash: string, tenant: string, report: string) =>
      pool.query(
        "INSERT INTO standalone_support_token_aliases (blob_sha256, tenant_id, diagnostic_id) VALUES ($1, $2, $3)",
        [hash, tenant, report],
      );
    await alias(HASH(14), "diag-a", source);
    await expect(alias(HASH(14), "diag-a", source)).rejects.toMatchObject({
      code: "23505",
      constraint: "standalone_support_token_aliases_pkey",
    });
    await expect(alias(HASH(15), "diag-b", source)).rejects.toMatchObject({
      code: "23503",
      constraint: "standalone_support_token_aliases_diagnostic_fk",
    });
    await expect(alias("not-a-hash", "diag-a", source)).rejects.toMatchObject({
      code: "23514",
      constraint: "standalone_support_token_aliases_blob_check",
    });
    await pool.query("DELETE FROM standalone_support_diagnostics WHERE id = $1", [source]);
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_token_aliases WHERE blob_sha256 = $1",
      [HASH(14)],
    );
    expect(left.rows[0]).toEqual({ n: 0 });
  });

  it("deletes the months with their source and everything with the tenant", async () => {
    const source = await diagnostic({ hash: HASH(11), generatedAt: "2026-10-19T09:00:00Z" });
    await month("diag-a", hostA, "2026-09", source);
    await pool.query("DELETE FROM standalone_support_diagnostics WHERE id = $1", [source]);
    const months = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_usage_months WHERE month = '2026-09' AND tenant_id = 'diag-a'",
    );
    expect(months.rows[0]).toEqual({ n: 0 });
    const kept = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_diagnostics WHERE tenant_id = 'diag-b'",
    );
    expect(kept.rows[0]).toEqual({ n: 1 });
    await pool.query("DELETE FROM standalone_support_diagnostics WHERE tenant_id = 'diag-b'");
    await diagnostic({
      hash: HASH(12),
      tenant: "diag-b",
      site: null,
      generatedAt: "2026-10-20T09:00:00Z",
    });
    await pool.query("DELETE FROM organization WHERE id = 'diag-b'");
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM standalone_support_diagnostics WHERE tenant_id = 'diag-b'",
    );
    expect(left.rows[0]).toEqual({ n: 0 });
  });
});
