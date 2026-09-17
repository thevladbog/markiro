import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
it("registers forward repair scheduling metadata after 0166", async () => {
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  expect(journal.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ idx: 166, tag: "0166_device_replacement_capabilities" }),
      expect.objectContaining({ idx: 167, tag: "0167_device_replacement_repair_schedule" }),
    ]),
  );
  const snapshot = JSON.parse(
    await readFile(join(migrationsFolder, "meta/0167_snapshot.json"), "utf8"),
  );
  expect(snapshot.tables["public.working_device_replacement_executions"].columns).toMatchObject({
    repair_attempts: { type: "integer", notNull: true, default: 0 },
    last_repair_at: { notNull: false },
    next_repair_at: { notNull: false },
  });
});

describe.skipIf(!process.env.DATABASE_URL)("replacement repair forward migration", () => {
  const name = `replacement_repair_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false,
    temporaryRoot = "",
    bytes = "",
    relation: unknown;
  const executions = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const startedAt = "2026-09-16T10:00:00Z";
  async function legacyBytes(upgraded = false) {
    return JSON.stringify(
      (
        await pool.query(
          `SELECT (${
            upgraded
              ? "to_jsonb(e) - ARRAY['repair_attempts','last_repair_at','next_repair_at']"
              : "to_jsonb(e)"
          })::text AS bytes FROM working_device_replacement_executions e ORDER BY id`,
        )
      ).rows,
    );
  }
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "replacement-repair-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: temporaryRoot,
      lastIncludedIndex: 166,
    });
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder: temporaryRoot,
      log: () => undefined,
    });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('repair-a','A','repair-a',now())",
    );
    for (const [index, executionId] of executions.entries()) {
      const source = randomUUID(),
        target = randomUUID(),
        preview = randomUUID(),
        preparation = randomUUID();
      await pool.query(
        "INSERT INTO station_devices(id,tenant_id,name,kind) VALUES ($1,'repair-a','Source','station'),($2,'repair-a','Target','station')",
        [source, target],
      );
      await pool.query(
        `INSERT INTO working_device_replacement_previews
        (id,tenant_id,device_id,actor_domain,actor_id,request_id,payload,payload_hash,facts_fingerprint,observation,expires_at)
        VALUES ($1,'repair-a',$2,'cabinet','owner',$3,'{}',$4,$4,'{}',now()+interval '5 minutes')`,
        [preview, source, randomUUID(), "a".repeat(64)],
      );
      await pool.query(
        `INSERT INTO working_device_replacement_preparations
        (id,tenant_id,device_id,preview_id,actor_domain,actor_id,observation,facts_fingerprint)
        VALUES ($1,'repair-a',$2,$3,'cabinet','owner','{}',$4)`,
        [preparation, source, preview, "a".repeat(64)],
      );
      await pool.query(
        `INSERT INTO working_device_replacement_executions
        (id,tenant_id,device_id,preparation_id,actor_domain,actor_id,request_id,request_hash,mode,source_credential_epoch,
        facts_fingerprint,emergency_reason,recovery_state,offline_authority_until,new_work_allowed_at,started_at,
        state,step,credential_revoked_at,target_device_id,executed_at,response)
        VALUES ($1,'repair-a',$2,$3,'cabinet','owner',$4,$5,'emergency',1,$5,'Source offline','required',$6,$6,$6,
        $7,$8,$9,$10,$11,$12)`,
        [
          executionId,
          source,
          preparation,
          randomUUID(),
          "a".repeat(64),
          index === 3 ? "2026-09-16T10:01:00Z" : startedAt,
          index === 2 ? "completed" : "executing",
          index === 2 ? "transferred" : index === 1 ? "credential_revoked" : "revoke_pending",
          index === 1 || index === 2 ? startedAt : null,
          index === 2 ? target : null,
          index === 2 ? startedAt : null,
          index === 2 ? { request: "saved" } : null,
        ],
      );
    }
    bytes = await legacyBytes();
    relation = (
      await pool.query(
        "SELECT oid,relfilenode FROM pg_class WHERE oid='working_device_replacement_executions'::regclass",
      )
    ).rows;
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
  it("preserves legacy execution values and heap files with zero/null additive defaults", async () => {
    expect(await legacyBytes(true)).toBe(bytes);
    expect(
      (
        await pool.query(
          "SELECT oid,relfilenode FROM pg_class WHERE oid='working_device_replacement_executions'::regclass",
        )
      ).rows,
    ).toEqual(relation);
    expect(
      (
        await pool.query(
          "SELECT repair_attempts,last_repair_at,next_repair_at FROM working_device_replacement_executions",
        )
      ).rows,
    ).toEqual(
      executions.map(() => ({ repair_attempts: 0, last_repair_at: null, next_repair_at: null })),
    );
  });
  it("rejects invalid counters, incomplete timestamps and scheduling before the execution", async () => {
    for (const [attempts, last, next] of [
      [-1, null, null],
      [1, null, null],
      [0, startedAt, startedAt],
      [1, "infinity", "infinity"],
      [1, "2026-09-16T09:59:59Z", startedAt],
      [1, "2026-09-16T10:00:30Z", startedAt],
    ])
      await expect(
        pool.query(
          "UPDATE working_device_replacement_executions SET revision=revision+1,repair_attempts=$2,last_repair_at=$3,next_repair_at=$4 WHERE id=$1",
          [executions[0], attempts, last, next],
        ),
      ).rejects.toMatchObject({ code: "23514" });
  });
  it("requires revision progress for retry updates and retains immutable execution facts", async () => {
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET repair_attempts=1,last_repair_at=$2,next_repair_at=$2::timestamptz+interval '30 seconds' WHERE id=$1",
        [executions[0], startedAt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,repair_attempts=1,last_repair_at=$2,next_repair_at=$2::timestamptz+interval '30 seconds',facts_fingerprint=$3 WHERE id=$1",
        [executions[0], startedAt, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE working_device_replacement_executions SET revision=revision+1,repair_attempts=1,last_repair_at=$2,next_repair_at=$2::timestamptz+interval '30 seconds' WHERE id=$1",
      [executions[0], startedAt],
    );
    const [row] = (
      await pool.query(
        "SELECT revision,repair_attempts FROM working_device_replacement_executions WHERE id=$1",
        [executions[0]],
      )
    ).rows;
    expect(row).toEqual({ revision: 2, repair_attempts: 1 });
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,repair_attempts=0,last_repair_at=null,next_repair_at=null WHERE id=$1",
        [executions[0]],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps completion immutable and orders both retries and new executions by due time", async () => {
    await expect(
      pool.query(
        "UPDATE working_device_replacement_executions SET revision=revision+1,repair_attempts=1,last_repair_at=$2,next_repair_at=$2::timestamptz+interval '30 seconds' WHERE id=$1",
        [executions[2], startedAt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const due = async (at: string) =>
      (
        await pool.query(
          "SELECT id FROM working_device_replacement_executions WHERE state='executing' AND COALESCE(next_repair_at,started_at) <= $1 ORDER BY COALESCE(next_repair_at,started_at),started_at,id",
          [at],
        )
      ).rows.map((row) => row.id);
    expect(await due(startedAt)).toEqual([executions[1]]);
    expect(await due("2026-09-16T10:00:30Z")).toEqual([executions[1], executions[0]]);
    expect(await due("2026-09-16T10:02:00Z")).toEqual([
      executions[1],
      executions[0],
      executions[3],
    ]);
    const index = (
      await pool.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname='replacement_executions_due_repair_idx'",
      )
    ).rows[0]?.indexdef;
    expect(index).toContain("COALESCE(next_repair_at, started_at), started_at, id");
    expect(index).toContain("WHERE (state = 'executing'::text)");
  });
});
