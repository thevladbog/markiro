import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stationDevices } from "../src/schema/platform.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

it("declares station kind as a non-null text column defaulting to station", () => {
  const column = getTableConfig(stationDevices).columns.find((column) => column.name === "kind");
  expect(column).toMatchObject({ notNull: true, hasDefault: true });
});

describe.skipIf(!process.env.DATABASE_URL)("station device kind migration", () => {
  const name = `markiro_station_kind_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let temporaryRoot = "";
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "station-kind-migration-"));
    const folder = fileURLToPath(new URL("../migrations", import.meta.url));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: folder,
      targetFolder: legacy,
      lastIncludedIndex: 122,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('legacy-kind','Legacy','legacy-kind',now())",
    );
    await pool.query(
      "INSERT INTO station_devices (tenant_id, name) VALUES ('legacy-kind', 'Legacy terminal')",
    );
    await migrate(drizzle(pool), { migrationsFolder: folder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("backfills existing stations as kind station", async () => {
    const rows = await pool.query(
      "SELECT kind FROM station_devices WHERE tenant_id = 'legacy-kind'",
    );
    expect(rows.rows).toEqual([{ kind: "station" }]);
  });

  it("accepts handheld and rejects any other kind", async () => {
    await pool.query(
      "INSERT INTO station_devices (tenant_id, name, kind) VALUES ('legacy-kind', 'TSD 1', 'handheld')",
    );
    await expect(
      pool.query(
        "INSERT INTO station_devices (tenant_id, name, kind) VALUES ('legacy-kind', 'Tablet', 'tablet')",
      ),
    ).rejects.toMatchObject({ constraint: "station_devices_kind_check" });
  });
});
