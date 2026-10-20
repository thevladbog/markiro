import { resolve } from "node:path";
import { createDb } from "../src/client.js";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import { describe, expect, it } from "vitest";

const base = process.env.US_TEST_DATABASE_URL;
const signature = "public.us_development_owner_provenance_v1(pg_catalog.text,pg_catalog.jsonb)";
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

async function dispose(f: Fixture) {
  if (!base) throw new Error("Missing isolated US test URL");
  const identity = (
    await f.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name,current_user AS owner",
    )
  ).rows[0];
  if (
    !identity ||
    !/^markiro_us_profile_[a-f0-9_]+$/.test(identity.name) ||
    identity.owner !== "markiro_us"
  )
    throw new Error("Owned fixture identity invalid");
  await f.close();
  const admin = createDb(base);
  try {
    expect(
      (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [identity.name]))
        .rows,
    ).toEqual([]);
    expect(
      (await admin.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [identity.name]))
        .rows,
    ).toEqual([]);
    console.info("disposed owner migration fixture", identity.name, "zero active clients");
  } finally {
    await admin.pool.end();
  }
}

async function runtime(f: Fixture) {
  if (!base) throw new Error("Missing isolated US test URL");
  const name = (await f.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
    ?.name;
  if (!name || !/^markiro_us_profile_[a-f0-9_]+$/.test(name))
    throw new Error("Owned database missing");
  const url = new URL(base);
  url.pathname = `/${name}`;
  return runRuntimeMigrations({
    databaseUrl: url.toString(),
    migrationsFolder: resolve("migrations"),
    log: () => {},
  });
}

async function assertContract(f: Fixture) {
  const rows = (
    await f.pool.query<{
      signature: string;
      owner: string;
      volatility: string;
      parallel: string;
      security_definer: boolean;
      strict: boolean;
      config: string[];
      return_type: string;
      acl: { grantee: string; privilege: string }[];
    }>(
      `
    SELECT p.oid::regprocedure::text AS signature, r.rolname AS owner,
           p.provolatile AS volatility, p.proparallel AS parallel,
           p.prosecdef AS security_definer, p.proisstrict AS strict,
           p.proconfig AS config, p.prorettype::regtype::text AS return_type,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',g.rolname,'privilege',a.privilege_type)
                      ORDER BY g.rolname,a.privilege_type)
                       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                       LEFT JOIN pg_roles g ON g.oid=a.grantee), '[]'::jsonb) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
     WHERE p.oid=$1::regprocedure
  `,
      [signature],
    )
  ).rows;
  expect(rows).toEqual([
    {
      signature: "us_development_owner_provenance_v1(text,jsonb)",
      owner: "markiro_us",
      volatility: "v",
      parallel: "u",
      security_definer: false,
      strict: false,
      config: ["search_path=pg_catalog"],
      return_type: "jsonb",
      acl: [{ grantee: "markiro_us", privilege: "EXECUTE" }],
    },
  ]);
}

describe.skipIf(!base)("US owner provenance migration in invocation-owned PostgreSQL", () => {
  it("installs the exact function and ACL through runtime migration and repeats as no-op", async () => {
    if (!base) throw new Error("Missing isolated US test URL");
    const f = await createUsProfileTestDatabase(base, 143);
    try {
      expect(
        (await f.pool.query("SELECT to_regprocedure($1)::text AS signature", [signature])).rows,
      ).toEqual([{ signature: null }]);
      const before = (
        await f.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows[0]?.count;
      expect((await runtime(f)).packaged).toContain("0144_us_owner_provenance");
      await assertContract(f);
      const after = (
        await f.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows[0]?.count;
      expect(before).toBe(144);
      // 0144 remains covered by every original function/ACL assertion; 0145 is
      // the independently owned additive structured Transformation guard.
      expect(after).toBe(146);
      expect(after).toBe((before ?? -1) + 2);
      await runtime(f);
      await assertContract(f);
      expect(
        (
          await f.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
          )
        ).rows[0]?.count,
      ).toBe(after);
    } finally {
      await dispose(f);
    }
  }, 60_000);

  it("denies execution and separately denies body SELECT to an existing restricted role", async () => {
    if (!base) throw new Error("Missing isolated US test URL");
    const f = await createUsProfileTestDatabase(base);
    const client = await f.pool.connect();
    try {
      await assertContract(f);
      const role = (
        await client.query<{ name: string }>(
          "SELECT rolname AS name FROM pg_roles WHERE rolname='pg_monitor'",
        )
      ).rows[0]?.name;
      if (role !== "pg_monitor") throw new Error("Existing restricted role unavailable");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE pg_monitor");
      expect(
        (await client.query<{ role: string }>("SELECT current_user AS role")).rows[0]?.role,
      ).toBe("pg_monitor");
      let noExecute: unknown;
      try {
        await client.query(
          `SELECT ${signature.replace(/\(.*$/, "")}($1::pg_catalog.text,$2::pg_catalog.jsonb)`,
          ["absent", null],
        );
      } catch (error) {
        noExecute = error;
      }
      expect(noExecute).toMatchObject({
        code: "42501",
        message: expect.stringContaining("permission denied for function"),
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO pg_monitor`);
      await client.query("SET LOCAL ROLE pg_monitor");
      expect(
        (await client.query<{ role: string }>("SELECT current_user AS role")).rows[0]?.role,
      ).toBe("pg_monitor");
      let noSelect: unknown;
      try {
        await client.query(
          `SELECT ${signature.replace(/\(.*$/, "")}($1::pg_catalog.text,$2::pg_catalog.jsonb)`,
          ["absent", null],
        );
      } catch (error) {
        noSelect = error;
      }
      expect(noSelect).toMatchObject({
        code: "42501",
        message: expect.stringContaining("permission denied for table organization"),
      });
      await client.query("ROLLBACK");
      await assertContract(f);
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
        await dispose(f);
      }
    }
  }, 60_000);

  it("rejects an unexpected default EXECUTE grantee atomically", async () => {
    if (!base) throw new Error("Missing isolated US test URL");
    const f = await createUsProfileTestDatabase(base, 143);
    try {
      await f.pool.query(
        "ALTER DEFAULT PRIVILEGES FOR ROLE markiro_us IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO pg_monitor",
      );
      const before = (
        await f.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows[0]?.count;
      let failure: unknown;
      try {
        await runtime(f);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
      expect(
        (await f.pool.query("SELECT to_regprocedure($1)::text AS signature", [signature])).rows,
      ).toEqual([{ signature: null }]);
      expect(
        (
          await f.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
          )
        ).rows[0]?.count,
      ).toBe(before);
    } finally {
      await f.pool.query(
        "ALTER DEFAULT PRIVILEGES FOR ROLE markiro_us IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM pg_monitor",
      );
      await dispose(f);
    }
  }, 60_000);
});
