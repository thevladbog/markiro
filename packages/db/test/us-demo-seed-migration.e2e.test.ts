import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
import { seed, transition } from "./support/us-receiving-snapshot-fixture.js";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const predecessorIndex = 140;
const journalIndex = 141;
const journalTag = "0141_us_demo_seed";
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

async function migrateThrough(f: Fixture, index: number) {
  const folder = await mkdtemp(join(tmpdir(), "markiro-us-demo-migrations-"));
  try {
    await copyMigrationsThroughIndex({
      sourceFolder: resolve("migrations"),
      targetFolder: folder,
      lastIncludedIndex: index,
    });
    await migrate(f.db, { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function assertTables(f: Fixture) {
  expect(
    (
      await f.pool.query(
        "SELECT to_regclass('traceability_demo_seeds')::text AS header, to_regclass('traceability_demo_seed_stages')::text AS stages",
      )
    ).rows,
  ).toEqual([{ header: "traceability_demo_seeds", stages: "traceability_demo_seed_stages" }]);
}

describe.skipIf(!url)("US demo journal additive migration in owned PostgreSQL databases", () => {
  let f: Fixture;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US test URL");
    f = await createUsProfileTestDatabase(url, journalIndex);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  async function tenant() {
    const id = randomUUID();
    await f.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
      [id],
    );
    return id;
  }
  async function header(tenantId: string, fields: Record<string, unknown> = {}) {
    const row = {
      id: randomUUID(),
      tenant_id: tenantId,
      scenario_version: "us-processor-demo-v1",
      definition_digest: "a".repeat(64),
      created_by: "synthetic-actor",
      ...fields,
    };
    const entries = Object.entries(row);
    await f.pool.query(
      `INSERT INTO traceability_demo_seeds(${entries.map(([k]) => k).join()}) VALUES(${entries.map((_, i) => `$${i + 1}`).join()})`,
      entries.map(([, v]) => v),
    );
    return row.id;
  }
  async function stage(tenantId: string, seedId: string, fields: Record<string, unknown> = {}) {
    const row = {
      id: randomUUID(),
      tenant_id: tenantId,
      seed_id: seedId,
      stage: "references",
      operation_key: randomUUID(),
      input_digest: "b".repeat(64),
      input: {},
      ...fields,
    };
    const entries = Object.entries(row);
    await f.pool.query(
      `INSERT INTO traceability_demo_seed_stages(${entries.map(([k]) => k).join()}) VALUES(${entries.map((_, i) => `$${i + 1}`).join()})`,
      entries.map(([k, v]) =>
        ["input", "receipt"].includes(k) && v !== null ? JSON.stringify(v) : v,
      ),
    );
    return row.id;
  }

  it("creates both tables on a fresh database", async () => {
    await assertTables(f);
  });

  it("binds stages to their tenant and retains headers/children on parent deletion attempts", async () => {
    const a = await tenant(),
      b = await tenant(),
      id = await header(a);
    await expect(header(randomUUID())).rejects.toMatchObject({ code: "23503" });
    await expect(stage(b, id)).rejects.toMatchObject({ code: "23503" });
    const child = await stage(a, id);
    await expect(header(a)).rejects.toMatchObject({ code: "23505" });
    await expect(
      f.pool.query("DELETE FROM traceability_demo_seeds WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(f.pool.query("DELETE FROM organization WHERE id=$1", [a])).rejects.toMatchObject({
      code: "23503",
    });
    expect(
      (
        await f.pool.query(
          "SELECT id,revision,receipt FROM traceability_demo_seed_stages WHERE id=$1",
          [child],
        )
      ).rows,
    ).toEqual([{ id: child, revision: 1, receipt: null }]);
  });

  it("rejects duplicate stages and operation keys while accepting all nine stages", async () => {
    const a = await tenant(),
      id = await header(a),
      key = randomUUID();
    await stage(a, id, { operation_key: key });
    await expect(stage(a, id)).rejects.toMatchObject({ code: "23505" });
    await expect(stage(a, id, { stage: "receiving", operation_key: key })).rejects.toMatchObject({
      code: "23505",
    });
    for (const name of [
      "receiving",
      "transformation",
      "cases",
      "shipping",
      "trace_readiness",
      "plan",
      "request",
      "package",
    ])
      await stage(a, id, {
        stage: name,
        receipt: { recordIds: [], resultDigest: "c".repeat(64), result: {} },
      });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM traceability_demo_seed_stages WHERE seed_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ n: 9 }]);
  });

  it.each([
    { revision: 0 },
    { revision: -1 },
    { definition_digest: "A".repeat(64) },
    { definition_digest: "a".repeat(63) },
    { definition_digest: "g".repeat(64) },
  ])("rejects invalid header revision/digest %j", async (fields) => {
    await expect(header(await tenant(), fields)).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    { revision: 0 },
    { revision: -1 },
    { stage: "complete" },
    { input_digest: "A".repeat(64) },
    { input_digest: "b".repeat(63) },
    { input_digest: "g".repeat(64) },
    { input: [] },
    { input: "scalar" },
    { input: 1 },
    { input: false },
    { receipt: [] },
    { receipt: "scalar" },
    { receipt: 1 },
    { receipt: false },
    { receipt: { padding: "é".repeat(8388608) } },
    { input: { padding: "é".repeat(8388608) } },
  ])("rejects invalid stage revision/digest/JSON case %#", async (fields) => {
    const a = await tenant(),
      id = await header(a);
    await expect(stage(a, id, fields)).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects JSON null distinctly from a nullable absent receipt and enforces the exact byte boundary", async () => {
    const a = await tenant(),
      id = await header(a);
    for (const column of ["input", "receipt"])
      await expect(
        f.pool.query(
          `INSERT INTO traceability_demo_seed_stages(tenant_id,seed_id,stage,operation_key,input_digest,input,receipt) VALUES($1,$2,'references',$3,$4,${column === "input" ? "'null'::jsonb" : "'{}'::jsonb"},${column === "receipt" ? "'null'::jsonb" : "NULL"})`,
          [a, id, randomUUID(), "b".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    // PostgreSQL renders {"x": "..."}: 9 envelope bytes.
    await stage(a, id, {
      input: { x: "a".repeat(16777207) },
      receipt: { x: "a".repeat(16777207) },
    });
    expect(
      (
        await f.pool.query(
          "SELECT octet_length(input::text) AS input_bytes,octet_length(receipt::text) AS receipt_bytes FROM traceability_demo_seed_stages WHERE seed_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ input_bytes: 16777216, receipt_bytes: 16777216 }]);
    await expect(
      stage(a, id, { stage: "receiving", input: { x: "a".repeat(16777208) } }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      stage(a, id, { stage: "receiving", receipt: { x: "a".repeat(16777208) } }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("retains valid compact API boundary JSON despite PostgreSQL separator whitespace and receipt envelope", async () => {
    const a = await tenant(),
      id = await header(a);
    const compact = { x: Array.from({ length: 131068 }, (_, index) => (index === 0 ? 10 : 0)) };
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBe(262144);
    await stage(a, id, {
      input: compact,
      receipt: { recordIds: [randomUUID()], resultDigest: "c".repeat(64), result: compact },
    });
    const bytes = await f.pool.query<{ input_bytes: number; receipt_bytes: number }>(
      "SELECT octet_length(input::text) AS input_bytes,octet_length(receipt::text) AS receipt_bytes FROM traceability_demo_seed_stages WHERE seed_id=$1",
      [id],
    );
    expect(bytes.rows[0]?.input_bytes).toBeGreaterThan(262144);
    expect(bytes.rows[0]?.receipt_bytes).toBeGreaterThan(262144);
  });

  it.each([
    { column: "input", value: 1e-300, count: 2000, compactBytes: 14007 },
    { column: "receipt", value: 1e-300, count: 2000, compactBytes: 14007 },
    { column: "receipt", value: 1e-300, count: 4000, compactBytes: 28007 },
    { column: "input", value: Number.MIN_VALUE, count: 37448, compactBytes: 262144 },
    { column: "receipt", value: Number.MIN_VALUE, count: 37448, compactBytes: 262144 },
  ])(
    "retains finite exponent evidence in $column ($count values) after JSONB decimal expansion",
    async ({ column, value, count, compactBytes }) => {
      const a = await tenant(),
        id = await header(a);
      const evidence = {
        x: Array.from({ length: count }, (_, index) =>
          value === Number.MIN_VALUE && index === 0 ? -value : value,
        ),
      };
      expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBe(compactBytes);
      const child = await stage(
        a,
        id,
        column === "input"
          ? { input: evidence }
          : {
              receipt: {
                recordIds: [randomUUID()],
                resultDigest: "c".repeat(64),
                result: evidence,
              },
            },
      );
      const stored = await f.pool.query<{ bytes: number }>(
        `SELECT octet_length(${column}::text) AS bytes FROM traceability_demo_seed_stages WHERE id=$1`,
        [child],
      );
      expect(stored.rows[0]?.bytes).toBeGreaterThan(524288);
      expect(stored.rows[0]?.bytes).toBeLessThan(16777216);
    },
  );

  it("preserves Receiving frozen bytes, Plan and request rows on predecessor upgrade and runtime retry", async () => {
    if (!url) throw new Error("Missing isolated US test URL");
    const old = await createUsProfileTestDatabase(url, 124);
    try {
      const specimen = await seed(old, "ordinary", 2);
      await transition(old, specimen);
      await migrateThrough(old, predecessorIndex);
      await old.pool.query(
        "INSERT INTO traceability_plan_versions(tenant_id,version_number,sections,created_by) VALUES($1,1,$2,'synthetic-actor')",
        [specimen.tenant, JSON.stringify({ procedure: "  Exact Ä  " })],
      );
      await old.pool.query(
        "INSERT INTO trace_requests(tenant_id,request_number,requester_name,received_at,due_at,created_by) VALUES($1,'SYNTHETIC-REQ','Synthetic',now(),now()+interval '24 hours','synthetic-actor')",
        [specimen.tenant],
      );
      const snapshot = () =>
        Promise.all(
          [
            "traceability_events",
            "receiving_event_roots",
            "receiving_event_items",
            "traceability_plan_versions",
            "trace_requests",
          ].map(
            async (table) =>
              (await old.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`))
                .rows,
          ),
        );
      const before = await snapshot();
      expect(
        (
          await old.pool.query(
            "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
            [specimen.id],
          )
        ).rows,
      ).toEqual([{ finalization_snapshot: specimen.snapshot }]);
      expect(
        (await old.pool.query("SELECT to_regclass('traceability_demo_seeds') AS name")).rows,
      ).toEqual([{ name: null }]);
      const identity = await old.pool.query<{ name: string; owner: string }>(
        "SELECT current_database() AS name,current_user AS owner",
      );
      const target = identity.rows[0];
      if (
        !target ||
        !/^markiro_us_profile_[a-f0-9_]+$/.test(target.name) ||
        target.owner !== "markiro_us"
      )
        throw new Error("Owned scratch identity mismatch");
      const ownedUrl = new URL(url);
      ownedUrl.pathname = `/${target.name}`;
      const result = await runRuntimeMigrations({
        databaseUrl: ownedUrl.toString(),
        migrationsFolder: resolve("migrations"),
        log: () => {},
      });
      expect(result.packaged).toContain(journalTag);
      await assertTables(old);
      expect(await snapshot()).toEqual(before);
      // The public runner applies the new migration above; a pinned copier and
      // second runtime invocation must recognize it without changing saved facts.
      await migrateThrough(old, journalIndex);
      const retry = await runRuntimeMigrations({
        databaseUrl: ownedUrl.toString(),
        migrationsFolder: resolve("migrations"),
        log: () => {},
      });
      expect(retry.packaged).toContain(journalTag);
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await old.pool.query(
            "SELECT (SELECT count(*)::int FROM traceability_demo_seeds) AS header,(SELECT count(*)::int FROM traceability_demo_seed_stages) AS stages",
          )
        ).rows,
      ).toEqual([{ header: 0, stages: 0 }]);
    } finally {
      await old.close();
    }
  }, 60_000);
});
