import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { countActualQueries } from "./support/us-dataset-query-counter";
import { readPreviousLockedSeed } from "./support/us-owner-provenance-reference";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { outcome, waitBlocked, withOwnedWork } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!base)("locked US owner adapter on an owned database", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let owner: Awaited<ReturnType<UsDevelopmentOwnerStore["provision"]>>;

  function observeNativeErrors<Client extends object>(client: Client) {
    let firstError: unknown;
    const observed = new Proxy(client, {
      get(connection, field) {
        if (field === "query")
          return async (...args: unknown[]) => {
            try {
              const query: unknown = Reflect.get(connection, "query", connection);
              if (typeof query !== "function") throw new Error("Native query method unavailable");
              return await Reflect.apply(query, connection, args);
            } catch (error) {
              firstError ??= error;
              throw error;
            }
          };
        const value: unknown = Reflect.get(connection, field, connection);
        return typeof value === "function" ? value.bind(connection) : value;
      },
    });
    return {
      observed,
      reset: () => {
        firstError = undefined;
      },
      read: () => firstError,
    };
  }

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test URL");
    fixture = await createUsProfileTestDatabase(base);
    owner = await new UsDevelopmentOwnerStore(fixture.db).provision(
      randomUUID() + randomUUID(),
      randomUUID(),
    );
  }, 60_000);

  afterAll(async () => {
    if (!fixture) return;
    const name = (await fixture.pool.query<{ name: string }>("SELECT current_database() AS name"))
      .rows[0]?.name;
    await fixture.close();
    if (!base || !name) throw new Error("Owned fixture cleanup identity missing");
    const admin = createDb(base);
    try {
      expect(
        (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [name])).rows,
      ).toEqual([]);
      expect(
        (await admin.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [name])).rows,
      ).toEqual([]);
      console.info("disposed owner adapter fixture", name, "zero active clients");
    } finally {
      await admin.pool.end();
    }
  });

  it("keeps the trusted result while forwarding one locked verification query", async () => {
    const at = new Date("2026-10-02T10:00:00.000Z");
    const store = new UsDevelopmentOwnerStore(fixture.db);
    const measured = await countActualQueries(fixture.pool, () =>
      fixture.db.transaction((tx) =>
        store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx),
      ),
    );
    expect(measured.value).toEqual({
      seedId: owner.tenantId,
      verifiedBy: "us-development-owner-v1",
      verifiedAt: at.toISOString(),
    });
    expect(measured.count).toBe(3); // BEGIN, one function dispatch, COMMIT.
  });

  it("matches the prior locked reader for every ordinary and hostile actor shape", async () => {
    const at = new Date("2026-10-02T10:00:00.000Z");
    const store = new UsDevelopmentOwnerStore(fixture.db);
    const throwingGetter = Object.defineProperty({}, "id", {
      get() {
        throw new Error("actor getter must not execute");
      },
    });
    const cases: { name: string; actor: unknown; trusted: boolean }[] = [
      { name: "normal", actor: owner.userId, trusted: true },
      { name: "undefined", actor: undefined, trusted: true },
      { name: "wrong", actor: randomUUID(), trusted: false },
      { name: "empty", actor: "", trusted: false },
      { name: "null", actor: null, trusted: false },
      { name: "number", actor: 1, trusted: false },
      { name: "boolean", actor: true, trusted: false },
      { name: "bigint", actor: 1n, trusted: false },
      { name: "symbol", actor: Symbol("actor"), trusted: false },
      { name: "boxed string", actor: new String(owner.userId), trusted: false },
      { name: "throwing getter", actor: throwingGetter, trusted: false },
      {
        name: "throwing JSON serialization",
        actor: {
          toJSON: () => {
            throw new Error("toJSON must not execute");
          },
        },
        trusted: false,
      },
      {
        name: "throwing driver conversion",
        actor: {
          toPostgres: () => {
            throw new Error("toPostgres must not execute");
          },
        },
        trusted: false,
      },
      { name: "NUL", actor: `${owner.userId}\0`, trusted: false },
      { name: "unpaired high surrogate", actor: `${owner.userId}\ud800`, trusted: false },
      { name: "unpaired low surrogate", actor: `${owner.userId}\udc00`, trusted: false },
      { name: "valid surrogate pair", actor: `${owner.userId}\ud83d\ude00`, trusted: false },
    ];
    for (const testCase of cases) {
      await fixture.db.transaction(async (tx) => {
        const previous = await readPreviousLockedSeed(
          tx,
          owner.tenantId,
          at,
          testCase.actor as string,
        );
        const actual = await store.verifyLockedTrustedSeed(
          owner.tenantId,
          testCase.actor as string,
          at,
          tx,
        );
        expect(actual, testCase.name).toEqual(previous);
        expect(actual !== null, testCase.name).toBe(testCase.trusted);
      });
    }
  });

  it.each(["read committed", "repeatable read"] as const)(
    "re-reads own transaction changes under %s without writing on verify",
    async (isolationLevel) => {
      const at = new Date("2026-10-02T10:00:00.000Z");
      const store = new UsDevelopmentOwnerStore(fixture.db);
      const expected = {
        seedId: owner.tenantId,
        verifiedBy: "us-development-owner-v1",
        verifiedAt: at.toISOString(),
      };
      const snapshot = async () => ({
        organizations: await fixture.db.select().from(schema.organization),
        users: await fixture.db.select().from(schema.user),
        memberships: await fixture.db.select().from(schema.member),
        accounts: await fixture.db.select().from(schema.account),
        audits: await fixture.db.select().from(schema.tenantAuditEvents),
      });
      const before = await snapshot();
      await fixture.db.transaction(
        async (tx) => {
          expect(await store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx)).toEqual(
            expected,
          );
          await tx.execute(
            sql`UPDATE public.organization SET name='Changed' WHERE id=${owner.tenantId}`,
          );
          expect(
            await store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx),
          ).toBeNull();
          await tx.execute(
            sql`UPDATE public.organization SET name='Synthetic US development' WHERE id=${owner.tenantId}`,
          );
          expect(await store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx)).toEqual(
            expected,
          );
        },
        { isolationLevel },
      );
      expect(await snapshot()).toEqual(before);
      expect(
        await fixture.db.transaction((tx) =>
          store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx),
        ),
      ).toEqual(expected);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("checks finite dates before dispatch and invokes the native function for SQL NULL tenant", async () => {
    const store = new UsDevelopmentOwnerStore(fixture.db);
    const invalid = await countActualQueries(fixture.pool, () =>
      fixture.db.transaction((tx) =>
        store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, new Date(Number.NaN), tx),
      ),
    );
    expect(invalid.value).toBeNull();
    expect(invalid.count).toBe(2); // Transaction begin/end only.
    const nullTenant = await countActualQueries(fixture.pool, () =>
      fixture.db.transaction((tx) =>
        store.verifyLockedTrustedSeed(null as unknown as string, owner.userId, new Date(), tx),
      ),
    );
    expect(nullTenant.value).toBeNull();
    expect(nullTenant.count).toBe(3); // Function must run despite SQL NULL tenant.
  });

  it("rejects malformed native facts and rechecks well-shaped facts in JavaScript", async () => {
    const store = new UsDevelopmentOwnerStore(fixture.db);
    const at = new Date("2026-10-02T10:00:00.000Z");
    const signature = "public.us_development_owner_provenance_v1(pg_catalog.text,pg_catalog.jsonb)";
    const definition = async () =>
      fixture.pool.query<{ definition: string; acl: string[] | null }>(
        "SELECT pg_get_functiondef($1::regprocedure) AS definition, proacl::text[] AS acl FROM pg_proc WHERE oid=$1::regprocedure",
        [signature],
      );
    const original = (await definition()).rows;
    class ExpectedRollback extends Error {}
    const rollback = new ExpectedRollback();
    const replace = (value: unknown) => {
      const literal = JSON.stringify(value).replaceAll("'", "''");
      return sql.raw(`CREATE OR REPLACE FUNCTION public.us_development_owner_provenance_v1(
        p_tenant pg_catalog.text, p_actor pg_catalog.jsonb) RETURNS pg_catalog.jsonb
        LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY INVOKER CALLED ON NULL INPUT
        SET search_path=pg_catalog AS $body$ BEGIN RETURN '${literal}'::pg_catalog.jsonb; END $body$`);
    };
    try {
      await fixture.db.transaction(async (tx) => {
        const native = await tx.execute<{ facts: unknown }>(sql`
          SELECT public.us_development_owner_provenance_v1(
            ${owner.tenantId}::pg_catalog.text, ${JSON.stringify(owner.userId)}::pg_catalog.jsonb
          ) AS facts
        `);
        const valid = native.rows[0]?.facts;
        if (typeof valid !== "object" || valid === null || Array.isArray(valid))
          throw new Error("Valid native facts unavailable");
        const facts = valid as Record<string, unknown>;
        const malformed = [
          {},
          { ...facts, codec: "unknown" },
          { ...facts, extra: true },
          { ...facts, memberships: { count: "one", soleRole: "owner" } },
          { ...facts, audits: { count: 1, sole: null } },
        ];
        for (const value of malformed) {
          await tx.execute(replace(value));
          await expect(
            store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx),
          ).rejects.toThrow("us_development_owner_provenance_contract_invalid");
        }
        await tx.execute(
          replace({
            ...facts,
            organization: { ...(facts.organization as object), id: randomUUID() },
          }),
        );
        expect(
          await store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx),
        ).toBeNull();
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect((await definition()).rows).toEqual(original);
    expect(
      await fixture.db.transaction((tx) =>
        store.verifyLockedTrustedSeed(owner.tenantId, owner.userId, at, tx),
      ),
    ).toMatchObject({ seedId: owner.tenantId });
  });

  it("propagates the missing-function native cause from the same driver execution", async () => {
    const at = new Date("2026-10-02T10:00:00.000Z");
    const client = await fixture.pool.connect();
    const observer = observeNativeErrors(client);
    const pinned = drizzle(observer.observed);
    let failure: unknown;
    try {
      await pinned.transaction(async (tx) => {
        await tx.execute(
          sql`DROP FUNCTION public.us_development_owner_provenance_v1(pg_catalog.text,pg_catalog.jsonb)`,
        );
        observer.reset();
        await new UsDevelopmentOwnerStore(fixture.db).verifyLockedTrustedSeed(
          owner.tenantId,
          owner.userId,
          at,
          tx,
        );
      });
    } catch (error) {
      failure = error;
    } finally {
      client.release();
    }
    expect(observer.read()).toMatchObject({ code: "42883" });
    expect(failure).toMatchObject({ cause: expect.objectContaining({ code: "42883" }) });
    if (!(failure instanceof Error)) throw new Error("Native missing-function failure absent");
    expect(failure.cause).toBe(observer.read());
    expect(
      await fixture.db.transaction((tx) =>
        new UsDevelopmentOwnerStore(fixture.db).verifyLockedTrustedSeed(
          owner.tenantId,
          owner.userId,
          at,
          tx,
        ),
      ),
    ).toMatchObject({ seedId: owner.tenantId });
  });

  it("propagates the restricted role's no-EXECUTE native cause without denial fallback", async () => {
    const at = new Date("2026-10-02T10:00:00.000Z");
    const client = await fixture.pool.connect();
    const observer = observeNativeErrors(client);
    const pinned = drizzle(observer.observed);
    let failure: unknown;
    try {
      await pinned.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE pg_monitor`);
        const role = await tx.execute<{ role: string }>(sql`SELECT current_user AS role`);
        expect(role.rows[0]?.role).toBe("pg_monitor");
        observer.reset();
        await new UsDevelopmentOwnerStore(fixture.db).verifyLockedTrustedSeed(
          owner.tenantId,
          owner.userId,
          at,
          tx,
        );
      });
    } catch (error) {
      failure = error;
    } finally {
      client.release();
    }
    expect(observer.read()).toMatchObject({ code: "42501" });
    expect(failure).toMatchObject({ cause: expect.objectContaining({ code: "42501" }) });
    if (!(failure instanceof Error)) throw new Error("Native no-EXECUTE failure absent");
    expect(failure.cause).toBe(observer.read());
  });

  it("locks organization then user before denying a hostile actor through the public method", async (t) => {
    const at = new Date("2026-10-02T10:00:00.000Z");
    const actor = {
      toJSON() {
        throw new Error("actor JSON hook must not run");
      },
      toPostgres() {
        throw new Error("actor driver hook must not run");
      },
    } as unknown as string;
    for (const table of ["organization", '"user"']) {
      await withOwnedWork(async (own) => {
        const writer = await fixture.pool.connect();
        let writerOpen = false;
        let writerReleased = false;
        own("writer-release", async () => {
          try {
            if (writerOpen) await writer.query("ROLLBACK");
          } finally {
            if (!writerReleased) writer.release();
          }
        });
        await writer.query("BEGIN");
        writerOpen = true;
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        await writer.query(`SELECT id FROM public.${table} WHERE id=$1 FOR UPDATE`, [
          table === "organization" ? owner.tenantId : owner.userId,
        ]);
        const reader = await fixture.pool.connect();
        own("reader-release", async () => {
          reader.release();
        });
        const readerPid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (writerPid === undefined || readerPid === undefined)
          throw new Error("Owned blocker identity missing");
        const running = outcome(
          drizzle(reader).transaction((tx) =>
            new UsDevelopmentOwnerStore(fixture.db).verifyLockedTrustedSeed(
              owner.tenantId,
              actor,
              at,
              tx,
            ),
          ),
        );
        own("reader-drain", async () => {
          await running;
        });
        own("writer-unblock", async () => {
          if (!writerOpen) return;
          try {
            await writer.query("ROLLBACK");
            writerOpen = false;
          } catch (error) {
            writer.release(true);
            writerReleased = true;
            throw error;
          }
        });
        await waitBlocked(fixture, writerPid, readerPid, t.signal);
        await writer.query("COMMIT");
        writerOpen = false;
        const result = await running;
        if (result.error !== undefined) throw result.error;
        expect(result.value).toBeNull();
      });
    }
  });

  it("preserves the same native 55P03 cause after an owned row lock timeout", async () => {
    await withOwnedWork(async (own) => {
      const writer = await fixture.pool.connect();
      let writerOpen = false;
      let writerReleased = false;
      own("writer-release", async () => {
        try {
          if (writerOpen) await writer.query("ROLLBACK");
        } finally {
          if (!writerReleased) writer.release();
        }
      });
      await writer.query("BEGIN");
      writerOpen = true;
      await writer.query("SELECT id FROM public.organization WHERE id=$1 FOR UPDATE", [
        owner.tenantId,
      ]);
      const reader = await fixture.pool.connect();
      own("reader-release", async () => {
        reader.release();
      });
      const observer = observeNativeErrors(reader);
      const running = outcome(
        drizzle(observer.observed).transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout='100ms'`);
          observer.reset();
          return new UsDevelopmentOwnerStore(fixture.db).verifyLockedTrustedSeed(
            owner.tenantId,
            owner.userId,
            new Date("2026-10-02T10:00:00.000Z"),
            tx,
          );
        }),
      );
      own("reader-drain", async () => {
        await running;
      });
      own("writer-unblock", async () => {
        if (!writerOpen) return;
        try {
          await writer.query("ROLLBACK");
          writerOpen = false;
        } catch (error) {
          writer.release(true);
          writerReleased = true;
          throw error;
        }
      });
      const result = await running;
      expect(observer.read()).toMatchObject({ code: "55P03" });
      expect(result.error).toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
      if (!(result.error instanceof Error)) throw new Error("Native lock-timeout failure absent");
      expect(result.error.cause).toBe(observer.read());
    });
  });
});
