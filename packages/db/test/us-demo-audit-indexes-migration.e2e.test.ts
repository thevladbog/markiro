import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const migrationsFolder = resolve("migrations");
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

async function identity(f: Fixture) {
  const row = (
    await f.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name, current_user AS owner",
    )
  ).rows[0];
  if (!row || !/^markiro_us_profile_[a-f0-9_]+$/.test(row.name) || row.owner !== "markiro_us")
    throw new Error("Owned audit fixture identity mismatch");
  return row.name;
}

async function dispose(f: Fixture) {
  const name = await identity(f);
  await f.close();
  if (!url) throw new Error("Missing isolated US test URL");
  const admin = createDb(url);
  try {
    expect(
      (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [name])).rows,
    ).toEqual([]);
    expect(
      (await admin.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [name])).rows,
    ).toEqual([]);
    console.info("disposed audit fixture", name, "zero active clients");
  } finally {
    await admin.pool.end();
  }
}

async function runtime(f: Fixture) {
  if (!url) throw new Error("Missing isolated US test URL");
  const owned = new URL(url);
  owned.pathname = `/${await identity(f)}`;
  return runRuntimeMigrations({ databaseUrl: owned.toString(), migrationsFolder, log: () => {} });
}

async function snapshot(f: Fixture) {
  const tables = (
    await f.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const hashes: Record<string, { count: number; sha256: string }> = {};
  // The bounded synthetic corpus is read one complete table at a time. Include
  // every column and every duplicate; no tenant filter or aggregate UNION.
  for (const { tablename } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error("Unexpected table identifier");
    const rows = (
      await f.pool.query<{ exact: string }>(
        `SELECT to_jsonb(t)::text AS exact FROM "${tablename}" t ORDER BY 1`,
      )
    ).rows;
    hashes[tablename] = {
      count: rows.length,
      sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }
  return hashes;
}

async function assertIndexes(f: Fixture) {
  const indexes = await f.pool.query(
    `SELECT c.relname AS name, i.indisunique AS unique, i.indisvalid AS valid,
      pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
     WHERE i.indrelid='tenant_audit_events'::regclass ORDER BY c.relname`,
  );
  expect(indexes.rows).toEqual([
    {
      name: "tenant_audit_events_pkey",
      unique: true,
      valid: true,
      definition:
        "CREATE UNIQUE INDEX tenant_audit_events_pkey ON public.tenant_audit_events USING btree (id)",
    },
    {
      name: "tenant_audit_events_tenant_action_idx",
      unique: false,
      valid: true,
      definition:
        "CREATE INDEX tenant_audit_events_tenant_action_idx ON public.tenant_audit_events USING btree (organization_id, action)",
    },
    {
      name: "tenant_audit_events_tenant_created_idx",
      unique: false,
      valid: true,
      definition:
        "CREATE INDEX tenant_audit_events_tenant_created_idx ON public.tenant_audit_events USING btree (organization_id, created_at)",
    },
    {
      name: "tenant_audit_events_tenant_request_idx",
      unique: false,
      valid: true,
      definition:
        "CREATE INDEX tenant_audit_events_tenant_request_idx ON public.tenant_audit_events USING btree (organization_id, request_id)",
    },
  ]);
}

async function seed(f: Fixture) {
  const tenants = [randomUUID(), randomUUID()];
  for (const tenant of tenants) {
    await f.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic audit fixture',$1,now())",
      [tenant],
    );
    await f.pool.query(
      `INSERT INTO tenant_audit_events(organization_id,action,outcome,target_type,target_id,"before","after",request_id,created_at)
       SELECT $1,'ordinary.'||g,'success','synthetic','target-'||g,
       jsonb_build_object('n',g,'nullable',null),jsonb_build_object('exact','  Ä 😀  '),
       'request-'||g,'2026-01-01T12:00:00Z'::timestamptz FROM generate_series(1,6000) g`,
      [tenant],
    );
    await duplicate(f, tenant);
    await duplicate(f, tenant);
  }
  await f.pool.query("ANALYZE tenant_audit_events");
  return tenants;
}

async function duplicate(f: Fixture, tenant: string) {
  await f.pool.query(
    `INSERT INTO tenant_audit_events(organization_id,action,outcome,target_type,target_id,"before","after",request_id,created_at)
     VALUES($1,'us.development.owner_provisioned','success','synthetic','same-target',
     '{"exact":"  Ä 😀  ","nullable":null}','{"values":[1,1,null]}','same-request','2026-01-02T12:00:00Z')`,
    [tenant],
  );
}

async function plans(f: Fixture, tenant: string) {
  const output: Record<string, string[]> = {};
  for (const [column, value] of [
    ["action", "us.development.owner_provisioned"],
    ["request_id", "same-request"],
  ] as const) {
    const query = `SELECT * FROM tenant_audit_events WHERE organization_id=$1 AND ${column}=$2 FOR SHARE`;
    expect((await f.pool.query(query, [tenant, value])).rows).toHaveLength(2);
    const result = await f.pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${query}`,
      [tenant, value],
    );
    output[column] = result.rows.map((row) => row["QUERY PLAN"]);
  }
  return output;
}

async function writeProbe(f: Fixture, tenant: string) {
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS, WAL)
       INSERT INTO tenant_audit_events(organization_id,action,outcome,target_type,request_id)
       VALUES($1,'write-probe','success','synthetic','write-probe')`,
      [tenant],
    );
    return result.rows.map((row) => row["QUERY PLAN"]);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

describe.skipIf(!url)("US audit index migration in invocation-owned native databases", () => {
  it.each(["drizzle", "runtime"] as const)(
    "creates exact indexes on a fresh %s migration and reruns idempotently",
    async (mode) => {
      if (!url) throw new Error("Missing isolated US test URL");
      const f = await createUsProfileTestDatabase(url, mode === "runtime" ? -1 : undefined);
      try {
        console.info("owned audit fixture", await identity(f), mode, "fresh");
        if (mode === "runtime") await runtime(f);
        await assertIndexes(f);
        const before = await snapshot(f);
        if (mode === "runtime") await runtime(f);
        else await migrate(f.db, { migrationsFolder });
        await assertIndexes(f);
        expect(await snapshot(f)).toEqual(before);
      } finally {
        await dispose(f);
      }
    },
    60_000,
  );

  it.each(["drizzle", "runtime"] as const)(
    "preserves every 0142 row, tenant and duplicate through %s upgrade and uses selective indexes",
    async (mode) => {
      if (!url) throw new Error("Missing isolated US test URL");
      const f = await createUsProfileTestDatabase(url, 142);
      try {
        console.info("owned audit fixture", await identity(f), mode, "upgrade");
        const tenants = await seed(f);
        const tenant = tenants[0];
        if (!tenant) throw new Error("Missing synthetic tenant");
        const before = await snapshot(f);
        const beforePlans = await plans(f, tenant);
        const beforeWrite = await writeProbe(f, tenant);
        const started = performance.now();
        if (mode === "runtime") {
          expect((await runtime(f)).packaged).toContain("0143_us_demo_audit_indexes");
        } else await migrate(f.db, { migrationsFolder });
        const migrationMs = performance.now() - started;
        await assertIndexes(f);
        expect(await snapshot(f)).toEqual(before);
        const afterPlans = await plans(f, tenant);
        const afterWrite = await writeProbe(f, tenant);
        expect(afterPlans.action?.join("\n")).toContain("tenant_audit_events_tenant_action_idx");
        expect(afterPlans.request_id?.join("\n")).toContain(
          "tenant_audit_events_tenant_request_idx",
        );
        console.info(
          "audit access measurements",
          JSON.stringify({
            mode,
            migrationMs,
            beforePlans,
            afterPlans,
            beforeWrite,
            afterWrite,
            indexBytes: (
              await f.pool.query(
                "SELECT indexrelname,pg_relation_size(indexrelid)::int AS bytes FROM pg_stat_user_indexes WHERE relname='tenant_audit_events' ORDER BY indexrelname",
              )
            ).rows,
            preservedTables: Object.keys(before).length,
            auditRows: before.tenant_audit_events?.count,
          }),
        );
        if (mode === "runtime") await runtime(f);
        else await migrate(f.db, { migrationsFolder });
        await assertIndexes(f);
        expect(await snapshot(f)).toEqual(before);
        // Nonunique indexes must continue admitting duplicate security evidence.
        for (const id of tenants) {
          await duplicate(f, id);
          expect(
            (
              await f.pool.query(
                "SELECT count(*)::int AS n FROM tenant_audit_events WHERE organization_id=$1 AND action='us.development.owner_provisioned' AND request_id='same-request'",
                [id],
              )
            ).rows,
          ).toEqual([{ n: 3 }]);
        }
      } finally {
        await dispose(f);
      }
    },
    60_000,
  );
});
