import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => {
  const calls: unknown[][] = [];
  const db = {};
  const drizzle = vi.fn(() => db);
  const migration = vi.fn();
  const readFile = vi.fn();
  const client = {
    query: vi.fn(async (query: string, values?: unknown[]) => {
      calls.push(["query", query, values]);
    }),
    release: vi.fn(() => {
      calls.push(["release"]);
    }),
  };
  const pool = {
    connect: vi.fn(async () => {
      calls.push(["connect"]);
      return client;
    }),
    end: vi.fn(async () => {
      calls.push(["pool.end"]);
    }),
  };
  const Pool = vi.fn(function Pool() {
    return pool;
  });

  return { Pool, calls, client, db, drizzle, migration, pool, readFile };
});

vi.mock("pg", () => ({ default: { Pool: harness.Pool } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: harness.drizzle }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: harness.migration,
}));
vi.mock("node:fs/promises", () => ({ readFile: harness.readFile }));

import { runRuntimeMigrations } from "../src/runtime-migrate.js";

const databaseUrl = "postgres://user:secret@db.internal/markiro";
const migrationsFolder = "/bundle/migrations";
const lockQuery = "SELECT pg_advisory_lock($1, $2)";
const unlockQuery = "SELECT pg_advisory_unlock($1, $2)";
const configureTimeoutsQuery =
  "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)";
const lockKeys = [1296126539, 1230131023];
const timeoutValues = ["120000ms", "900000ms"];
const execFile = promisify(execFileCallback);
const databaseUrlFromEnvironment = process.env.DATABASE_URL;
const migrationsFolderOnDisk = fileURLToPath(new URL("../migrations", import.meta.url));
const runtimeMigrateModule = fileURLToPath(new URL("../src/runtime-migrate.ts", import.meta.url));
const pickupPolicyMigration = new URL(
  "../migrations/0036_kiosk_pickup_policy.sql",
  import.meta.url,
);
const organizationBrandingMigration = new URL(
  "../migrations/0037_organization_branding.sql",
  import.meta.url,
);
const kioskSsccOrdersMigration = new URL(
  "../migrations/0038_kiosk_sscc_orders.sql",
  import.meta.url,
);
const migrationJournal = new URL("../migrations/meta/_journal.json", import.meta.url);

const legacyStationMigrationFixture = String.raw`
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const databaseUrl = process.env.MARKIRO_LEGACY_FIXTURE_DATABASE_URL;
const migrationsFolder = process.env.MARKIRO_LEGACY_FIXTURE_MIGRATIONS_FOLDER;
const runtimeModule = process.env.MARKIRO_LEGACY_FIXTURE_RUNTIME_MODULE;

if (!databaseUrl || !migrationsFolder || !runtimeModule) {
  throw new Error("Legacy migration fixture is missing required configuration");
}

const databaseName = "markiro_runtime_" + randomUUID().replaceAll("-", "_");
const scratchUrl = new URL(databaseUrl);
scratchUrl.pathname = "/" + databaseName;
scratchUrl.search = "";
const temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-runtime-migrate-"));
const legacyMigrationsFolder = join(temporaryRoot, "migrations");
const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
let pool;
let databaseCreated = false;
let primaryError;
let cleanupError;

function quoteDatabaseIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return '"' + identifier + '"';
}

try {
  await maintenancePool.query("CREATE DATABASE " + quoteDatabaseIdentifier(databaseName));
  databaseCreated = true;
  await cp(migrationsFolder, legacyMigrationsFolder, { recursive: true });
  await rm(join(legacyMigrationsFolder, "0029_loving_triathlon.sql"));
  await rm(join(legacyMigrationsFolder, "meta", "0029_snapshot.json"));
  const journalPath = join(legacyMigrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry) => entry.tag !== "0029_loving_triathlon");
  await writeFile(journalPath, JSON.stringify(journal));

  pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  await migrate(drizzle(pool), { migrationsFolder: legacyMigrationsFolder });
  await pool.query(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, $4)",
    ["runtime-fixture-tenant", "Runtime fixture", "runtime-fixture", new Date("2026-08-06T00:00:00.000Z")],
  );
  await pool.query(
    "INSERT INTO station_devices (id, tenant_id, name, api_key_id, enrolled_at) VALUES ($1, $2, $3, $4, $5)",
    [
      "00000000-0000-0000-0000-000000000001",
      "runtime-fixture-tenant",
      "Legacy station",
      "legacy-api-key",
      new Date("2026-08-06T00:00:00.000Z"),
    ],
  );
  await pool.query(
    "INSERT INTO sscc_blocks (tenant_id, issuer_prefix, extension_digit, device_id, from_serial, to_serial) VALUES ($1, $2, $3, $4, $5, $6)",
    ["runtime-fixture-tenant", "460000000", 1, "00000000-0000-0000-0000-000000000001", 1, 1],
  );

  const { runRuntimeMigrations } = await import(pathToFileURL(runtimeModule).href);
  await runRuntimeMigrations({ databaseUrl: scratchUrl.toString(), migrationsFolder, log: () => {} });

  const result = await pool.query(
    "SELECT d.id, d.api_key_id, d.enrolled_at, b.device_id FROM station_devices d JOIN sscc_blocks b ON b.tenant_id = d.tenant_id AND b.device_id = d.id WHERE d.id = $1",
    ["00000000-0000-0000-0000-000000000001"],
  );
  process.stdout.write(
    JSON.stringify({
      record: result.rows[0],
      databaseUrlArguments: process.argv.filter((argument) => argument.includes(databaseUrl)),
    }),
  );
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await pool?.end();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (databaseCreated) {
    try {
      await maintenancePool.query("DROP DATABASE " + quoteDatabaseIdentifier(databaseName));
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    await maintenancePool.end();
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError === undefined && cleanupError !== undefined) {
    throw cleanupError;
  }
}
`;

function resetHarness() {
  harness.calls.splice(0);
  harness.Pool.mockClear();
  harness.client.query.mockReset();
  harness.client.query.mockImplementation(async (query: string, values?: unknown[]) => {
    harness.calls.push(["query", query, values]);
  });
  harness.client.release.mockClear();
  harness.drizzle.mockClear();
  harness.migration.mockReset();
  harness.pool.connect.mockClear();
  harness.pool.end.mockClear();
  harness.readFile.mockReset();
  harness.readFile.mockResolvedValue(
    JSON.stringify({
      entries: [{ tag: "0028_avatar-owner-integrity" }, { tag: "0029_loving_triathlon" }],
    }),
  );
  harness.migration.mockImplementation(
    async (_db: unknown, config: { migrationsFolder: string }) => {
      harness.calls.push(["migrate", config.migrationsFolder]);
    },
  );
}

afterEach(resetHarness);
resetHarness();

describe("runRuntimeMigrations", () => {
  test("packages tenant and employee pickup policy backfills", () => {
    const migration = readFileSync(pickupPolicyMigration, "utf8");
    const journal = JSON.parse(readFileSync(migrationJournal, "utf8")) as {
      entries: Array<{ tag: string }>;
    };

    expect(migration).toContain('CREATE TYPE "public"."pickup_limit_mode"');
    expect(migration).toContain("INSERT INTO pickup_tenant_policies (tenant_id, limits_enabled)");
    expect(migration).toContain("INSERT INTO employee_pickup_policies");
    expect(journal.entries.map((entry) => entry.tag)).toContain("0036_kiosk_pickup_policy");
  });

  test("packages tenant-owned organization branding metadata", () => {
    const migration = readFileSync(organizationBrandingMigration, "utf8");
    const journal = JSON.parse(readFileSync(migrationJournal, "utf8")) as {
      entries: Array<{ tag: string }>;
    };

    expect(migration).toContain('CREATE TABLE "organization_logo_assets"');
    expect(migration).toContain('CONSTRAINT "org_profiles_logo_tenant_fk"');
    expect(migration).toContain('FOREIGN KEY ("tenant_id","logo_asset_id")');
    expect(journal.entries.map((entry) => entry.tag)).toContain("0037_organization_branding");
  });

  test("packages kiosk box provenance with a committed tenant registry revision", () => {
    expect(existsSync(kioskSsccOrdersMigration)).toBe(true);
    if (!existsSync(kioskSsccOrdersMigration)) return;

    const migration = readFileSync(kioskSsccOrdersMigration, "utf8");
    const journal = JSON.parse(readFileSync(migrationJournal, "utf8")) as {
      entries: Array<{ tag: string }>;
    };

    expect(migration).toContain('CREATE TABLE "pickup_order_boxes"');
    expect(migration).toContain('CREATE TABLE "box_registry_versions"');
    expect(migration).toContain('"current_version" bigint DEFAULT 0 NOT NULL');
    expect(migration).toContain(
      'ALTER TABLE "boxes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;',
    );
    expect(migration).toContain(
      'ALTER TABLE "boxes" ADD COLUMN "registry_version" bigint DEFAULT 0 NOT NULL;',
    );
    expect(migration).toContain(
      'CONSTRAINT "box_registry_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id")',
    );
    expect(migration).toContain(
      'INSERT INTO "box_registry_versions" ("tenant_id", "current_version") SELECT "id", 0 FROM "organization" ON CONFLICT ("tenant_id") DO NOTHING;',
    );
    expect(migration).not.toMatch(/\bUPDATE\s+"?boxes"?/iu);
    expect(migration).toContain(
      'CREATE INDEX "boxes_registry_cursor_idx" ON "boxes" USING btree ("tenant_id","registry_version","id");',
    );
    expect(migration).toContain('CONSTRAINT "pickup_order_items_tenant_order_box_fk"');
    expect(migration).toContain(
      'FOREIGN KEY ("tenant_id","order_id","order_box_id") REFERENCES "public"."pickup_order_boxes"("tenant_id","order_id","id")',
    );
    expect(journal.entries.map((entry) => entry.tag)).toContain("0038_kiosk_sscc_orders");
  });

  test("holds one session advisory lock across the runtime migration", async () => {
    const logs: string[] = [];

    const result = await runRuntimeMigrations({
      databaseUrl,
      migrationsFolder,
      log: (message) => logs.push(message),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    expect(harness.calls).toEqual([
      ["connect"],
      ["query", configureTimeoutsQuery, timeoutValues],
      ["query", lockQuery, lockKeys],
      ["migrate", migrationsFolder],
      ["query", unlockQuery, lockKeys],
      ["release"],
      ["pool.end"],
    ]);
    expect(harness.drizzle).toHaveBeenCalledWith(harness.client);
    expect(harness.migration).toHaveBeenCalledWith(harness.db, { migrationsFolder });
    expect(harness.Pool).toHaveBeenCalledWith({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 30_000,
    });
    expect(result).toEqual({
      packaged: ["0028_avatar-owner-integrity", "0029_loving_triathlon"],
      completedAt: "2026-08-04T12:00:00.000Z",
    });
  });

  test.skipIf(!databaseUrlFromEnvironment)(
    "preserves a legacy keyed station and SSCC reference through the real 0029 migration",
    async () => {
      const { stdout } = await execFile(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          legacyStationMigrationFixture,
        ],
        {
          env: {
            ...process.env,
            MARKIRO_LEGACY_FIXTURE_DATABASE_URL: databaseUrlFromEnvironment!,
            MARKIRO_LEGACY_FIXTURE_MIGRATIONS_FOLDER: migrationsFolderOnDisk,
            MARKIRO_LEGACY_FIXTURE_RUNTIME_MODULE: runtimeMigrateModule,
          },
        },
      );

      expect(JSON.parse(stdout)).toEqual({
        record: {
          id: "00000000-0000-0000-0000-000000000001",
          api_key_id: "legacy-api-key",
          enrolled_at: "2026-08-06T00:00:00.000Z",
          device_id: "00000000-0000-0000-0000-000000000001",
        },
        databaseUrlArguments: [],
      });
    },
    20_000,
  );

  test("releases the lock, client, and pool when migration fails", async () => {
    const migrationError = new Error("provider says " + databaseUrl);
    harness.migration.mockRejectedValueOnce(migrationError);

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: vi.fn() }),
    ).rejects.toBe(migrationError);

    expect(harness.calls).toEqual([
      ["connect"],
      ["query", configureTimeoutsQuery, timeoutValues],
      ["query", lockQuery, lockKeys],
      ["query", unlockQuery, lockKeys],
      ["release"],
      ["pool.end"],
    ]);
  });

  test("preserves the migration error when unlock also fails", async () => {
    const migrationError = new Error("migration failed");
    harness.migration.mockRejectedValueOnce(migrationError);
    harness.client.query
      .mockImplementationOnce(async (query: string, values?: unknown[]) => {
        harness.calls.push(["query", query, values]);
      })
      .mockImplementationOnce(async (query: string, values?: unknown[]) => {
        harness.calls.push(["query", query, values]);
      })
      .mockImplementationOnce(async (query: string, values?: unknown[]) => {
        harness.calls.push(["query", query, values]);
        throw new Error("unlock failed");
      });

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: vi.fn() }),
    ).rejects.toBe(migrationError);
    expect(harness.client.release).toHaveBeenCalledOnce();
    expect(harness.pool.end).toHaveBeenCalledOnce();
  });

  test("unlocks and closes resources when advisory lock acquisition fails", async () => {
    const logs: string[] = [];
    const lockError = new Error("provider says " + databaseUrl);
    harness.client.query
      .mockImplementationOnce(async (query: string, values?: unknown[]) => {
        harness.calls.push(["query", query, values]);
      })
      .mockImplementationOnce(async (query: string, values?: unknown[]) => {
        harness.calls.push(["query", query, values]);
        throw lockError;
      })
      .mockImplementationOnce(async (query: string, values?: unknown[]) => {
        harness.calls.push(["query", query, values]);
        throw new Error("unlock failed");
      });

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: (message) => logs.push(message) }),
    ).rejects.toBe(lockError);

    expect(harness.calls).toEqual([
      ["connect"],
      ["query", configureTimeoutsQuery, timeoutValues],
      ["query", lockQuery, lockKeys],
      ["query", unlockQuery, lockKeys],
      ["release"],
      ["pool.end"],
    ]);
    expect(logs).toEqual([
      "runtime migration started",
      "migration packaged: 0028_avatar-owner-integrity",
      "migration packaged: 0029_loving_triathlon",
      "runtime migration failed",
    ]);
    expect(logs.join("\n")).not.toContain(databaseUrl);
  });

  test("uses explicit database-side bounds supplied for a production migration", async () => {
    await runRuntimeMigrations({
      databaseUrl,
      migrationsFolder,
      connectionTimeoutMs: 12_000,
      advisoryLockTimeoutMs: 34_000,
      statementTimeoutMs: 56_000,
      log: vi.fn(),
    });

    expect(harness.Pool).toHaveBeenCalledWith({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 12_000,
    });
    expect(harness.calls).toContainEqual(["query", configureTimeoutsQuery, ["34000ms", "56000ms"]]);
  });

  test("logs packaged tags without SQL or connection secrets", async () => {
    const logs: string[] = [];
    harness.readFile.mockResolvedValueOnce(
      JSON.stringify({
        entries: [{ tag: "0028_avatar-owner-integrity", sql: "secret migration SQL" }],
      }),
    );

    await runRuntimeMigrations({
      databaseUrl,
      migrationsFolder,
      log: (message) => logs.push(message),
    });

    expect(logs).toContain("migration packaged: 0028_avatar-owner-integrity");
    expect(logs.join("\n")).not.toContain("secret migration SQL");
    expect(logs.join("\n")).not.toContain(databaseUrl);
  });

  test("logs only a stable failure phrase when migration fails", async () => {
    const logs: string[] = [];
    harness.migration.mockRejectedValueOnce(new Error("provider says " + databaseUrl));

    await expect(
      runRuntimeMigrations({ databaseUrl, migrationsFolder, log: (message) => logs.push(message) }),
    ).rejects.toThrow("provider says");

    expect(logs).toContain("runtime migration failed");
    expect(logs.join("\n")).not.toContain(databaseUrl);
  });

  test("rejects an empty database URL before constructing a pool", async () => {
    await expect(
      runRuntimeMigrations({ databaseUrl: "", migrationsFolder, log: vi.fn() }),
    ).rejects.toThrow("DATABASE_URL is required");

    expect(harness.Pool).not.toHaveBeenCalled();
  });
});
