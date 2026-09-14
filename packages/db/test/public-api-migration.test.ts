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
describe.skipIf(!databaseUrl)("public API actor forward upgrade", () => {
  const name = `public_actor_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const maintenance = new pg.Pool({ connectionString: databaseUrl }),
    pool = new pg.Pool({ connectionString: url.toString() });
  let directory = "",
    created = false;
  const productId = randomUUID(),
    lineId = randomUUID(),
    inventoryId = randomUUID();
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    directory = await mkdtemp(join(tmpdir(), "public-actor-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: directory,
      lastIncludedIndex: 144,
    });
    await migrate(drizzle(pool), { migrationsFolder: directory });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('public-owner','Owner','public-owner',now()),('other-owner','Other','other-owner',now())",
    );
    await pool.query(
      "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES('cabinet','Cabinet','cabinet@example.invalid',now(),now())",
    );
    await pool.query(
      "INSERT INTO apikey(id,config_id,reference_id,key,metadata,created_at,updated_at) VALUES('historical-key','public','public-owner','test-hash','{\"kind\":\"public\"}',now(),now())",
    );
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,'public-owner','04680089900383','Historical')",
      [productId],
    );
    await pool.query(
      "INSERT INTO lines(id,tenant_id,name) VALUES($1,'public-owner','Historical')",
      [lineId],
    );
    await pool.query(
      "INSERT INTO inventories(id,tenant_id,number,product_id,gtin14_snapshot,line_id,mode,production_date_from,production_date_to,created_by_user_id) VALUES($1,'public-owner','IVN-26-000001',$2,'04680089900383',$3,'check','2026-08-01','2026-08-31','cabinet')",
      [inventoryId, productId, lineId],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  });
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("backfills real public identity and preserves cabinet history", async () => {
    expect(
      (
        await pool.query(
          "SELECT tenant_id FROM public_api_key_identities WHERE key_id='historical-key'",
        )
      ).rows,
    ).toEqual([{ tenant_id: "public-owner" }]);
    expect(
      (
        await pool.query(
          "SELECT created_by_user_id,created_by_public_key_id FROM inventories WHERE id=$1",
          [inventoryId],
        )
      ).rows,
    ).toEqual([{ created_by_user_id: "cabinet", created_by_public_key_id: null }]);
  });
  it("keeps identity after secret deletion and rejects XOR/cross-tenant actor violations", async () => {
    await pool.query("DELETE FROM apikey WHERE id='historical-key'");
    expect(
      (
        await pool.query(
          "SELECT key_id FROM public_api_key_identities WHERE key_id='historical-key'",
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      pool.query("UPDATE inventories SET created_by_public_key_id='historical-key' WHERE id=$1", [
        inventoryId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "INSERT INTO public_api_key_identities(key_id,tenant_id) VALUES('foreign-key','other-owner')",
    );
    await expect(
      pool.query(
        "UPDATE inventories SET created_by_user_id=NULL,created_by_public_key_id='foreign-key' WHERE id=$1",
        [inventoryId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("UPDATE inventories SET started_by_public_key_id='historical-key' WHERE id=$1", [
        inventoryId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
