import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
it("registers the capability table in a new forward migration and snapshot", async () => {
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  expect(journal.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ idx: 172, tag: "0172_device_replacement_capabilities" }),
    ]),
  );
  const snapshot = JSON.parse(
    await readFile(join(migrationsFolder, "meta/0172_snapshot.json"), "utf8"),
  );
  expect(snapshot.tables["public.working_device_replacement_capabilities"]).toBeDefined();
});
describe.skipIf(!process.env.DATABASE_URL)("replacement capability forward migration", () => {
  const name = `replacement_capability_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false,
    temporaryRoot = "",
    before = "";
  const source = randomUUID(),
    foreign = randomUUID(),
    preparation = randomUUID();
  async function legacyBytes() {
    return JSON.stringify(
      (
        await pool.query(
          "SELECT row_to_json(p)::text AS bytes FROM working_device_replacement_preparations p ORDER BY id",
        )
      ).rows,
    );
  }
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "replacement-capability-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: temporaryRoot,
      lastIncludedIndex: 171,
    });
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder: temporaryRoot,
      log: () => undefined,
    });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('compat-a','A','compat-a',now()),('compat-b','B','compat-b',now())",
    );
    await pool.query(
      "INSERT INTO station_devices(id,tenant_id,name,kind) VALUES ($1,'compat-a','Source','station'),($2,'compat-b','Foreign','station')",
      [source, foreign],
    );
    const preview = randomUUID();
    await pool.query(
      `INSERT INTO working_device_replacement_previews
      (id,tenant_id,device_id,actor_domain,actor_id,request_id,payload,payload_hash,facts_fingerprint,observation,expires_at)
      VALUES ($1,'compat-a',$2,'cabinet','owner',$3,'{}',$4,$4,'{}',now()+interval '5 minutes')`,
      [preview, source, randomUUID(), "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO working_device_replacement_preparations
      (id,tenant_id,device_id,preview_id,actor_domain,actor_id,observation,facts_fingerprint)
      VALUES ($1,'compat-a',$2,$3,'cabinet','owner','{}',$4)`,
      [preparation, source, preview, "a".repeat(64)],
    );
    before = await legacyBytes();
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  it("preserves legacy preparations byte-for-byte and creates no capability or intent implicitly", async () => {
    expect(await legacyBytes()).toBe(before);
    expect(
      (await pool.query("SELECT * FROM working_device_replacement_capabilities")).rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT * FROM working_device_replacement_readiness_intents")).rows,
    ).toEqual([]);
  });
  it("enforces tenant ownership, positive epoch, bounded finite TTL and identity uniqueness", async () => {
    const insert = (deviceId = source, epoch = 1, expires = "2026-10-01T12:05:00Z") =>
      pool.query(
        "INSERT INTO working_device_replacement_capabilities (tenant_id,device_id,credential_epoch,supported,observed_at,expires_at) VALUES ('compat-a',$1,$2,true,'2026-10-01T12:00:00Z',$3)",
        [deviceId, epoch, expires],
      );
    await expect(insert(foreign)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(source, 0)).rejects.toMatchObject({ code: "23514" });
    for (const expires of ["infinity", "2026-10-01T12:00:00Z", "2026-10-01T12:05:00.001Z"])
      await expect(insert(source, 1, expires)).rejects.toMatchObject({ code: "23514" });
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await insert(source, 2);
  });
});
