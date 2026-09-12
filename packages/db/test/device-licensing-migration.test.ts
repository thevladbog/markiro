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
describe.skipIf(!databaseUrl)("working device forward migration", () => {
  const name = `markiro_device_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let temporaryRoot = "";
  let created = false;
  let beforeDevices: unknown;
  let legacyOccupied: unknown;
  let beforeActorConstraint: unknown;
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-device-"));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 132,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('device-a','A','device-a',now()),('device-b','B','device-b',now())",
    );
    for (const tenant of ["device-a", "device-b"]) {
      for (const [label, paired, key, revoked] of [
        ["unpaired", false, false, false],
        ["paired", true, true, false],
        ["key-only", false, true, false],
        ["paired-only", true, false, false],
        ["revoked", false, false, true],
        ["contradictory", true, true, true],
      ] as const) {
        await pool.query(
          "INSERT INTO station_devices (tenant_id,name,kind,paired_at,api_key_id,revoked_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            tenant,
            label,
            label === "key-only" ? "handheld" : "station",
            paired ? new Date("2026-01-01") : null,
            key ? "legacy-key-reference" : null,
            revoked ? new Date("2026-02-01") : null,
          ],
        );
      }
    }
    beforeDevices = (await pool.query("SELECT * FROM station_devices ORDER BY id")).rows;
    legacyOccupied = (
      await pool.query(
        "SELECT tenant_id,count(*)::int AS count FROM station_devices WHERE revoked_at IS NULL GROUP BY tenant_id ORDER BY tenant_id",
      )
    ).rows;
    const initialAssignments = join(temporaryRoot, "initial-assignments");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: initialAssignments,
      lastIncludedIndex: 133,
    });
    await migrate(drizzle(pool), { migrationsFolder: initialAssignments });
    beforeActorConstraint = (await pool.query("SELECT * FROM working_device_events ORDER BY id"))
      .rows;
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
  it("preserves all legacy rows, occupied totals and honest migration observations", async () => {
    expect((await pool.query("SELECT * FROM working_device_events ORDER BY id")).rows).toEqual(
      beforeActorConstraint,
    );
    expect((await pool.query("SELECT * FROM station_devices ORDER BY id")).rows).toEqual(
      beforeDevices,
    );
    expect(
      (
        await pool.query(
          "SELECT tenant_id,count(*)::int AS count FROM working_device_assignments WHERE state <> 'released' GROUP BY tenant_id ORDER BY tenant_id",
        )
      ).rows,
    ).toEqual(legacyOccupied);
    const observations = (await pool.query("SELECT * FROM working_device_events")).rows;
    expect(observations).toHaveLength(12);
    expect(
      observations.every(
        (e) => e.actor_domain === "migration" && e.actor_id === null && e.action === "observed",
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT d.name,a.state,a.release_reason FROM working_device_assignments a JOIN station_devices d ON d.id=a.device_id WHERE d.tenant_id='device-a' ORDER BY d.name",
        )
      ).rows,
    ).toEqual([
      { name: "contradictory", state: "released", release_reason: "security_revoked" },
      { name: "key-only", state: "assigned", release_reason: null },
      { name: "paired", state: "assigned", release_reason: null },
      { name: "paired-only", state: "assigned", release_reason: null },
      { name: "revoked", state: "released", release_reason: "security_revoked" },
      { name: "unpaired", state: "reserved", release_reason: null },
    ]);
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect((await pool.query("SELECT * FROM working_device_events")).rows).toEqual(observations);
  });
  it.each(["cabinet", "platform", "device"])(
    "requires identity for %s events",
    async (actorDomain) => {
      const insert = `INSERT INTO working_device_events (tenant_id,device_id,actor_domain,actor_id,action,"after")
      SELECT tenant_id,id,$1,$2,'observed','{}' FROM station_devices WHERE tenant_id='device-a' AND name='unpaired'`;
      await expect(pool.query(insert, [actorDomain, null])).rejects.toMatchObject({
        code: "23514",
      });
      expect((await pool.query(insert, [actorDomain, "actor-identity"])).rowCount).toBe(1);
    },
  );
  it.each(["migration", "system"])("retains anonymous %s observations", async (actorDomain) => {
    const result = await pool.query(
      `INSERT INTO working_device_events (tenant_id,device_id,actor_domain,actor_id,action,"after")
      SELECT tenant_id,id,$1,null,'observed','{}' FROM station_devices WHERE tenant_id='device-a' AND name='unpaired'
      RETURNING actor_domain,actor_id`,
      [actorDomain],
    );
    expect(result.rows).toEqual([{ actor_domain: actorDomain, actor_id: null }]);
  });
  it("pins last events to the same device, deduplicates requests and permits security reacquisition", async () => {
    const rows = (
      await pool.query<{ device_id: string; last_event_id: string }>(
        "SELECT device_id,last_event_id FROM working_device_assignments WHERE tenant_id='device-b' ORDER BY device_id",
      )
    ).rows;
    const first = rows[0],
      second = rows[1];
    if (!first || !second) throw new Error("fixtures missing");
    await expect(
      pool.query("UPDATE working_device_assignments SET last_event_id=$1 WHERE device_id=$2", [
        second.last_event_id,
        first.device_id,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "INSERT INTO working_device_events (tenant_id,device_id,actor_domain,action,\"after\") VALUES ('device-a',$1,'system','observed','{}')",
        [first.device_id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const request = randomUUID();
    const insert =
      "INSERT INTO working_device_events (tenant_id,device_id,actor_domain,action,\"after\",request_id) VALUES ('device-b',$1,'system','observed','{}',$2)";
    await pool.query(insert, [first.device_id, request]);
    await expect(pool.query(insert, [second.device_id, request])).rejects.toMatchObject({
      code: "23505",
    });
    const reacquired = await pool.query(
      "UPDATE working_device_assignments SET state='assigned',release_reason=null,released_at=null,revision=revision+1 WHERE tenant_id='device-b' AND release_reason='security_revoked' RETURNING state",
    );
    expect(reacquired.rowCount).toBe(2);
  });
  it("invalidates cached usage transactionally on assignment changes", async () => {
    const usage = async () =>
      BigInt(
        (
          await pool.query<{ usage_revision: string }>(
            "SELECT usage_revision FROM entitlement_revisions WHERE tenant_id='device-b'",
          )
        ).rows[0]?.usage_revision ?? "0",
      );
    const before = await usage();
    await pool.query(
      "UPDATE working_device_assignments SET revision=revision+1 WHERE tenant_id='device-b' AND state='reserved'",
    );
    expect(await usage()).toBeGreaterThan(before);
    const stable = await usage();
    await pool.query(
      "UPDATE working_device_assignments SET revision=revision WHERE tenant_id='device-b'",
    );
    expect(await usage()).toBe(stable);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE working_device_assignments SET revision=revision+1 WHERE tenant_id='device-b'",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await usage()).toBe(stable);
  });
  it("preserves existing device deletion cleanup without permitting direct journal deletion", async () => {
    const device = randomUUID();
    await pool.query(
      "INSERT INTO station_devices (id,tenant_id,name) VALUES ($1,'device-a','cascade fixture')",
      [device],
    );
    const event = randomUUID();
    await pool.query(
      "INSERT INTO working_device_events (id,tenant_id,device_id,actor_domain,action,\"after\") VALUES ($1,'device-a',$2,'system','reserved','{}')",
      [event, device],
    );
    await pool.query(
      "INSERT INTO working_device_assignments (tenant_id,device_id,state,provenance,last_event_id) VALUES ('device-a',$1,'reserved','runtime',$2)",
      [device, event],
    );
    await pool.query("DELETE FROM station_devices WHERE id=$1", [device]);
    expect(
      (await pool.query("SELECT * FROM working_device_events WHERE device_id=$1", [device])).rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT * FROM working_device_assignments WHERE device_id=$1", [device]))
        .rows,
    ).toEqual([]);
  });
  it("denies duplicates, cross-tenant references, invalid release shapes and journal rewrites", async () => {
    const device = (
      await pool.query<{ id: string }>(
        "SELECT id FROM station_devices WHERE tenant_id='device-a' AND name='unpaired'",
      )
    ).rows[0];
    if (!device) throw new Error("fixture missing");
    await expect(
      pool.query(
        "INSERT INTO working_device_assignments (tenant_id,device_id,state,provenance) VALUES ('device-a',$1,'reserved','runtime')",
        [device.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        "INSERT INTO working_device_assignments (tenant_id,device_id,state,provenance) VALUES ('device-b',$1,'reserved','runtime')",
        [device.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("UPDATE working_device_assignments SET state='released' WHERE device_id=$1", [
        device.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE working_device_assignments SET revision=0 WHERE device_id=$1", [
        device.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE working_device_events SET actor_id='fake'")).rejects.toThrow();
    await expect(pool.query("DELETE FROM working_device_events")).rejects.toThrow();
    await pool.query(
      "UPDATE working_device_assignments SET state='released',release_reason='reservation_cancelled',released_at=now(),revision=revision+1 WHERE device_id=$1",
      [device.id],
    );
    await expect(
      pool.query(
        "UPDATE working_device_assignments SET state='reserved',release_reason=null,released_at=null WHERE device_id=$1",
        [device.id],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM working_device_assignments WHERE device_id=$1", [device.id]),
    ).rejects.toThrow();
  });
});
