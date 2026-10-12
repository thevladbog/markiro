import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
describe.skipIf(!databaseUrl)("pallet V2 additive PostgreSQL migration", () => {
  const name = `markiro_pallet_v2_${randomUUID().replaceAll("-", "_")}`;
  const scratch = new URL(databaseUrl ?? "postgres://invalid");
  scratch.pathname = `/${name}`;
  scratch.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratch.toString() });
  let created = false,
    directory = "";
  const device = randomUUID(),
    pallet = randomUUID(),
    shift = randomUUID(),
    product = randomUUID();
  const revision = "a".repeat(64),
    sscc = "146000000000001231";
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    directory = await mkdtemp(join(tmpdir(), "markiro-pallet-v2-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: directory,
      lastIncludedIndex: 189,
    });
    await migrate(drizzle(pool), { migrationsFolder: directory });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('tenant-a','A','pallet-v2-a',now()),('tenant-b','B','pallet-v2-b',now())",
    );
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name,status) VALUES($1,'tenant-a','04600000000015','Historical','active')",
      [product],
    );
    await pool.query(
      "INSERT INTO shifts(id,tenant_id,product_id,mode,number_month_key,number_seq) VALUES($1,'tenant-a',$2,'aggregation','OCT26',1)",
      [shift, product],
    );
    await pool.query(
      "INSERT INTO station_devices(id,tenant_id,name,kind) VALUES($1,'tenant-a','Origin','station')",
      [device],
    );
    await pool.query(
      "INSERT INTO pallets(id,tenant_id,shift_id,terminal_id,device_pallet_id,sscc) VALUES($1,'tenant-a',$2,$3,'pallet',$4)",
      [pallet, shift, device, sscc],
    );
    await pool.query(
      "INSERT INTO pallet_label_sources(tenant_id,sscc,pallet_id,source_device_id,revision,value) VALUES('tenant-a',$1,$2,$3,$4,'{\"historical\":true}')",
      [sscc, pallet, device, revision],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 180000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("preserves sources and rejects cross-tenant rendering device bindings", async () => {
    expect((await pool.query("SELECT revision,value FROM pallet_label_sources")).rows).toEqual([
      { revision, value: { historical: true } },
    ]);
    const job = randomUUID();
    await pool.query(
      "INSERT INTO pallet_reprint_renderings(tenant_id,device_id,job_id,sscc,source_revision,rendering_revision,value) VALUES('tenant-a',$1,$2,$3,$4,$4,'{}')",
      [device, job, sscc, revision],
    );
    await expect(
      pool.query(
        "INSERT INTO pallet_reprint_renderings(tenant_id,device_id,job_id,sscc,source_revision,rendering_revision,value) VALUES('tenant-b',$1,$2,$3,$4,$4,'{}')",
        [device, randomUUID(), sscc, revision],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("admits a single resolution for one original attempt", async () => {
    await pool.query(
      "INSERT INTO pallet_production_resolutions(tenant_id,source_device_id,event_id,sscc,source_revision,attempt_id,digest,value) VALUES('tenant-a',$1,$2,$3,$4,'original',$4,'{}')",
      [device, randomUUID(), sscc, revision],
    );
    await expect(
      pool.query(
        "INSERT INTO pallet_production_resolutions(tenant_id,source_device_id,event_id,sscc,source_revision,attempt_id,digest,value) VALUES('tenant-a',$1,$2,$3,$4,'original',$4,'{}')",
        [device, randomUUID(), sscc, revision],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
