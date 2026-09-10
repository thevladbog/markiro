import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("offer print variant forward migration", () => {
  const databaseName = `markiro_offer_variant_${randomUUID().replaceAll("-", "_")}`;
  const scratch = new URL(databaseUrl ?? "postgres://invalid");
  scratch.pathname = `/${databaseName}`;
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratch.toString() });
  const offerId = randomUUID();
  const documentId = randomUUID();
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const migrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    // Reconstruct the actual predecessor, including hand-authored migrations.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const migration of migrations.slice(0, 127)) {
        for (const statement of migration.sql) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await pool.query(
      "insert into organization (id, name, slug, created_at) values ($1, 'Legacy tenant', $1, now())",
      [tenantId],
    );
    await pool.query(
      "insert into platform_users (id, name, email, role, status) values ($1, 'Legacy actor', $2, 'accountant', 'active')",
      [actorId, `${actorId}@example.invalid`],
    );
    await pool.query(
      "insert into commercial_offers (id, tenant_id, family_id, revision, total, created_by_platform_user_id) values ($1, $2, $1, 5, '100.00', $3)",
      [offerId, tenantId, actorId],
    );
    await pool.query(
      "insert into commercial_offer_documents (id, tenant_id, offer_id, revision, format, status, object_key, content_type, sha256, byte_size, renderer_version) values ($1,$2,$3,5,'html','ready','legacy/r5.html','text/html',$4,42,'legacy-renderer')",
      [documentId, tenantId, offerId, "a".repeat(64)],
    );
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.end();
  });
  it("retains legacy key and metadata, allows a signed peer, and rejects duplicate or unknown variants", async () => {
    const before = await pool.query("select * from commercial_offer_documents where id=$1", [
      documentId,
    ]);
    const migration = migrations[127];
    if (!migration) throw new Error("Offer variant migration missing");
    for (const statement of migration.sql) await pool.query(statement);
    const after = await pool.query("select * from commercial_offer_documents where id=$1", [
      documentId,
    ]);
    expect(after.rows).toEqual([{ ...before.rows[0], print_variant: "clean" }]);
    const insert =
      "insert into commercial_offer_documents (tenant_id, offer_id, revision, format, print_variant, renderer_version) values ($1,$2,5,'html',$3,'test')";
    await pool.query(insert, [tenantId, offerId, "signed"]);
    await expect(pool.query(insert, [tenantId, offerId, "clean"])).rejects.toMatchObject({
      code: "23505",
    });
    await expect(pool.query(insert, [tenantId, offerId, "signed"])).rejects.toMatchObject({
      code: "23505",
    });
    await expect(pool.query(insert, [tenantId, offerId, "unknown"])).rejects.toMatchObject({
      code: "23514",
    });
    await pool.query(
      "insert into commercial_offer_documents (tenant_id, offer_id, revision, format, renderer_version) values ($1,$2,5,'pdf','test')",
      [tenantId, offerId],
    );
    const defaults = await pool.query(
      "select print_variant from commercial_offer_documents where offer_id=$1 and format='pdf'",
      [offerId],
    );
    expect(defaults.rows).toEqual([{ print_variant: "clean" }]);
  });
});
