import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "@markiro/db/runtime-migrate";
import { createDb } from "../src/client.js";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
import { seed, transition } from "./support/us-receiving-snapshot-fixture.js";

const url = process.env.US_TEST_DATABASE_URL;
const predecessorIndex = 141;
const datasetIndex = 142;
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

async function tenant(f: Fixture) {
  const id = randomUUID();
  await f.pool.query(
    "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
    [id],
  );
  return id;
}
async function header(
  f: Fixture,
  tenantId: string,
  compact = false,
  fields: Record<string, unknown> = {},
) {
  const row = {
    id: randomUUID(),
    tenant_id: tenantId,
    ...(compact
      ? { scenario_version: "us-processor-demo-v1" }
      : { version: "us-processor-six-month-v1", manifest: {} }),
    definition_digest: "a".repeat(64),
    created_by: "synthetic-actor",
    ...fields,
  };
  const entries = Object.entries(row);
  await f.pool.query(
    `INSERT INTO ${compact ? "traceability_demo_seeds" : "traceability_demo_datasets"}(${entries.map(([k]) => k).join()}) VALUES(${entries.map((_, i) => `$${i + 1}`).join()})`,
    entries.map(([k, v]) => (k === "manifest" ? JSON.stringify(v) : v)),
  );
  return row.id;
}
async function stage(
  f: Fixture,
  tenantId: string,
  datasetId: string,
  fields: Record<string, unknown> = {},
) {
  const row = {
    id: randomUUID(),
    tenant_id: tenantId,
    dataset_id: datasetId,
    unit_key: "chain_a",
    stage: "receiving",
    operation_key: randomUUID(),
    input_digest: "b".repeat(64),
    input: {},
    ...fields,
  };
  const entries = Object.entries(row);
  await f.pool.query(
    `INSERT INTO traceability_demo_dataset_stages(${entries.map(([k]) => k).join()}) VALUES(${entries.map((_, i) => `$${i + 1}`).join()})`,
    entries.map(([k, v]) =>
      k === "input" || (k === "receipt" && v !== null) ? JSON.stringify(v) : v,
    ),
  );
  return row.id;
}
async function identity(f: Fixture) {
  const target = (
    await f.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name,current_user AS owner",
    )
  ).rows[0];
  if (
    !target ||
    !/^markiro_us_profile_[a-f0-9_]+$/.test(target.name) ||
    target.owner !== "markiro_us"
  )
    throw new Error("Owned scratch identity mismatch");
  console.log("owned dataset fixture", target.name, target.owner);
  return target;
}
async function dispose(f: Fixture) {
  const target = await identity(f);
  await f.close();
  if (!url) throw new Error("Missing isolated US test URL");
  const admin = createDb(url);
  try {
    expect(
      (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [target.name]))
        .rows,
    ).toEqual([]);
    console.log("disposed dataset fixture", target.name);
  } finally {
    await admin.pool.end();
  }
}
async function hashes(f: Fixture) {
  const tables = (
    await f.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('traceability_demo_datasets','traceability_demo_dataset_stages') ORDER BY tablename",
    )
  ).rows;
  return Object.fromEntries(
    await Promise.all(
      tables.map(async ({ tablename }) => {
        const rows = (
          await f.pool.query(`SELECT to_jsonb(t)::text AS exact FROM "${tablename}" t ORDER BY 1`)
        ).rows;
        return [tablename, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
      }),
    ),
  );
}

describe.skipIf(!url)("US dataset additive migration in owned PostgreSQL databases", () => {
  let f: Fixture;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US test URL");
    f = await createUsProfileTestDatabase(url, datasetIndex);
    await identity(f);
  }, 60_000);
  afterAll(async () => {
    if (f) await dispose(f);
  });

  it("creates a fresh dataset journal", async () => {
    expect(
      (
        await f.pool.query(
          "SELECT to_regclass('traceability_demo_datasets')::text AS header,to_regclass('traceability_demo_dataset_stages')::text AS stages",
        )
      ).rows,
    ).toEqual([
      { header: "traceability_demo_datasets", stages: "traceability_demo_dataset_stages" },
    ]);
  });
  it("accepts Receiving for separate units and denies duplicates, cross-tenant linkage and cascading deletion", async () => {
    const a = await tenant(f),
      b = await tenant(f),
      id = await header(f, a),
      key = randomUUID();
    await stage(f, a, id, { operation_key: key });
    await stage(f, a, id, { unit_key: "chain_b" });
    await expect(stage(f, a, id)).rejects.toMatchObject({ code: "23505" });
    await expect(
      stage(f, a, id, { unit_key: "chain_c", operation_key: key }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(header(f, a)).rejects.toMatchObject({ code: "23505" });
    await expect(header(f, randomUUID())).rejects.toMatchObject({ code: "23503" });
    await expect(stage(f, b, id)).rejects.toMatchObject({ code: "23503" });
    await expect(
      f.pool.query("DELETE FROM traceability_demo_datasets WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(f.pool.query("DELETE FROM organization WHERE id=$1", [a])).rejects.toMatchObject({
      code: "23503",
    });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE dataset_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });
  it.each([
    { version: "us-processor-demo-v1" },
    { definition_digest: "A".repeat(64) },
    { definition_digest: "a".repeat(63) },
    { manifest: [] },
    { manifest: null },
    { manifest: { x: "a".repeat(16777208) } },
  ])("rejects malformed header %#", async (fields) => {
    await expect(header(f, await tenant(f), false, fields)).rejects.toMatchObject({
      code: "23514",
    });
  });
  it.each([
    { revision: 0 },
    { revision: 3 },
    { revision: 2 },
    { revision: 1, receipt: {} },
    { unit_key: "Bad" },
    { unit_key: "a".repeat(65) },
    { stage: "complete" },
    { input_digest: "g".repeat(64) },
    { input: [] },
    { input: null },
    { input: 1 },
    { receipt: [], revision: 2 },
    { receipt: false, revision: 2 },
    { input: { x: "a".repeat(16777208) } },
    { receipt: { x: "a".repeat(16777208) }, revision: 2 },
  ])("rejects malformed stage/revision/evidence %#", async (fields) => {
    const a = await tenant(f),
      id = await header(f, a);
    await expect(stage(f, a, id, fields)).rejects.toMatchObject({ code: "23514" });
  });
  it("accepts completed stages and all valid names with actual timestamps and exact storage ceilings", async () => {
    const a = await tenant(f),
      id = await header(f, a, false, { manifest: { x: "a".repeat(16777207) } });
    for (const name of [
      "references",
      "receiving",
      "amend_receiving",
      "void_receiving",
      "transformation",
      "cases",
      "shipping",
      "trace_readiness",
      "plan",
      "request",
      "package",
    ])
      await stage(f, a, id, { stage: name, revision: 2, receipt: {} });
    await stage(f, a, id, {
      unit_key: "boundary",
      revision: 2,
      input: { x: "a".repeat(16777207) },
      receipt: { x: "a".repeat(16777207) },
    });
    expect(
      (
        await f.pool.query(
          "SELECT octet_length(input::text) AS i,octet_length(receipt::text) AS r FROM traceability_demo_dataset_stages WHERE dataset_id=$1 AND unit_key='boundary'",
          [id],
        )
      ).rows,
    ).toEqual([{ i: 16777216, r: 16777216 }]);
    expect(
      (
        await f.pool.query(
          "SELECT octet_length(manifest::text) AS m,created_at BETWEEN now()-interval '1 minute' AND now() AS actual FROM traceability_demo_datasets WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ m: 16777216, actual: true }]);
  });
  it.each([true, false])(
    "rejects the opposite journal after compact-first=%s initialization",
    async (compact) => {
      const a = await tenant(f);
      await header(f, a, compact);
      await expect(header(f, a, !compact)).rejects.toMatchObject({ code: "23514" });
    },
  );
  it.each([true, false])(
    "serializes concurrent INSERTs with compact winner=%s",
    async (compact) => {
      const a = await tenant(f),
        first = await f.pool.connect(),
        second = await f.pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        const pid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        const insert = (isCompact: boolean) =>
          isCompact
            ? "INSERT INTO traceability_demo_seeds(tenant_id,scenario_version,definition_digest,created_by) VALUES($1,'us-processor-demo-v1',$2,'synthetic-actor')"
            : "INSERT INTO traceability_demo_datasets(tenant_id,version,definition_digest,manifest,created_by) VALUES($1,'us-processor-six-month-v1',$2,'{}','synthetic-actor')";
        await first.query(insert(compact), [a, "a".repeat(64)]);
        // Attach the rejection handler before releasing the winner; the second
        // command must have started and be waiting inside the actual trigger.
        pending = second.query(insert(!compact), [a, "a".repeat(64)]);
        const outcome = pending.then(
          () => null,
          (error: unknown) => error,
        );
        for (let attempt = 0; attempt < 100; attempt++) {
          const wait = await f.pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [
            pid,
          ]);
          if (wait.rows[0]?.wait_event === "advisory") break;
          if (attempt === 99)
            throw new Error("Concurrent header did not wait for shared advisory lock");
          await new Promise((done) => setTimeout(done, 10));
        }
        await first.query("COMMIT");
        expect(await outcome).toMatchObject({ code: "23514" });
        await second.query("ROLLBACK");
        expect(
          (
            await f.pool.query(
              "SELECT (SELECT count(*) FROM traceability_demo_seeds WHERE tenant_id=$1)+(SELECT count(*) FROM traceability_demo_datasets WHERE tenant_id=$1) AS n",
              [a],
            )
          ).rows,
        ).toEqual([{ n: "1" }]);
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        await pending?.catch(() => {});
        first.release();
        second.release();
      }
    },
  );
  it("preserves every predecessor table and compact replay through packaged migration and retry", async () => {
    if (!url) throw new Error("Missing isolated US test URL");
    const old = await createUsProfileTestDatabase(url, 124);
    try {
      const specimen = await seed(old, "ordinary", 2);
      await transition(old, specimen);
      const folder = await mkdtemp(join(tmpdir(), "markiro-us-dataset-upgrade-"));
      try {
        await copyMigrationsThroughIndex({
          sourceFolder: resolve("migrations"),
          targetFolder: folder,
          lastIncludedIndex: predecessorIndex,
        });
        await migrate(old.db, { migrationsFolder: folder });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      await old.pool.query(
        "INSERT INTO traceability_plan_versions(tenant_id,version_number,sections,created_by) VALUES($1,1,$2,'synthetic-actor')",
        [specimen.tenant, '{"procedure":"  Exact Ä  "}'],
      );
      await old.pool.query(
        "INSERT INTO trace_requests(tenant_id,request_number,requester_name,received_at,due_at,created_by) VALUES($1,'SYNTHETIC-REQ','Synthetic',now(),now()+interval '24 hours','synthetic-actor')",
        [specimen.tenant],
      );
      const target = await identity(old),
        a = specimen.tenant,
        compact = await header(old, a, true);
      await old.pool.query(
        "INSERT INTO traceability_demo_seed_stages(tenant_id,seed_id,stage,operation_key,input_digest,input,receipt) VALUES($1,$2,'references',$3,$4,$5,$6)",
        [
          a,
          compact,
          randomUUID(),
          "b".repeat(64),
          '{"exact":"  Ä  "}',
          '{"result":{"frozen":true}}',
        ],
      );
      const before = await hashes(old),
        ownedUrl = new URL(url);
      ownedUrl.pathname = `/${target.name}`;
      const result = await runRuntimeMigrations({
        databaseUrl: ownedUrl.toString(),
        migrationsFolder: resolve("migrations"),
        log: () => {},
      });
      expect(result.packaged.some((tag) => tag.startsWith("0142_"))).toBe(true);
      expect(
        (await old.pool.query("SELECT to_regclass('traceability_demo_datasets')::text AS name"))
          .rows,
      ).toEqual([{ name: "traceability_demo_datasets" }]);
      expect(await hashes(old)).toEqual(before);
      await runRuntimeMigrations({
        databaseUrl: ownedUrl.toString(),
        migrationsFolder: resolve("migrations"),
        log: () => {},
      });
      expect(await hashes(old)).toEqual(before);
      console.log("predecessor preservation hashes", JSON.stringify(before));
      const b = await tenant(old);
      await header(old, b, true);
      await expect(header(old, a)).rejects.toMatchObject({ code: "23514" });
      expect(
        (
          await old.pool.query(
            "SELECT input::text,receipt::text FROM traceability_demo_seed_stages WHERE seed_id=$1",
            [compact],
          )
        ).rows,
      ).toEqual([{ input: '{"exact": "  Ä  "}', receipt: '{"result": {"frozen": true}}' }]);
    } finally {
      await dispose(old);
    }
  }, 60_000);
});
