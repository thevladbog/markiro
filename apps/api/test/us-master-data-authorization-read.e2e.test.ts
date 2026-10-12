import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { US_CAPABILITY, type UsCapability } from "@markiro/domain";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authorizeUsMasterData } from "../src/modules/traceability/master-data/us-master-data-support";
import { assertUsDemoTarget } from "../src/modules/traceability/demo/us-demo-target";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("native ordered master data authorization", () => {
  const harness = specialFixture(base);
  const denied = () => {
    throw new Error("us_dataset_target_invalid");
  };
  const authorize = (required: UsCapability | readonly UsCapability[] = US_CAPABILITY.READ) => {
    const { f, context } = harness;
    return f.db.transaction((tx) =>
      authorizeUsMasterData(tx, context.tenantId, context.actorUserId, required),
    );
  };
  // Catches redundant profile round trips at the actual transaction boundary.
  it(
    "bounds actual authorization including BEGIN and COMMIT",
    harness.phase(async () => {
      const { f, context } = harness;
      const before = await f.snapshot();
      const measured = await countActualQueries(f.pool, () =>
        f.db.transaction((tx) =>
          authorizeUsMasterData(tx, context.tenantId, context.actorUserId, US_CAPABILITY.READ),
        ),
      );
      console.info(
        `Authorization budget: count=${measured.count} durationMs=${measured.durationMs.toFixed(3)}`,
      );
      expect(measured.value).toBe("US_FSMA204_PROCESSOR");
      expect(await f.snapshot()).toEqual(before);
      expect(measured.count).toBeLessThanOrEqual(4);
    }),
  );
  // Catches a second timezone read after the same native authorization invocation.
  it(
    "bounds actual target including BEGIN and COMMIT",
    harness.phase(async () => {
      const { f, context } = harness;
      const before = await f.snapshot();
      const measured = await countActualQueries(f.pool, () =>
        f.db.transaction((tx) => assertUsDemoTarget(tx, f.db, context, denied)),
      );
      console.info(
        `Target budget: count=${measured.count} durationMs=${measured.durationMs.toFixed(3)}`,
      );
      expect(await f.snapshot()).toEqual(before);
      expect(measured.count).toBeLessThanOrEqual(9);
    }),
  );
  // Catches SQL copies of role policy, all-of alternatives and empty-array grants.
  it.each([
    ["owner", US_CAPABILITY.QA_MANAGE, true],
    ["admin", US_CAPABILITY.MEMBERS_MANAGE, true],
    ["manager", US_CAPABILITY.QA_MANAGE, false],
    ["traceability_auditor", [US_CAPABILITY.QA_MANAGE, US_CAPABILITY.EXPORT_READ], true],
    ["traceability_shipping", [US_CAPABILITY.RECEIVING_WRITE, US_CAPABILITY.SHIPPING_WRITE], true],
    ["traceability_receiving", US_CAPABILITY.TRANSFORMATION_WRITE, false],
    ["unknown, traceability_production,traceability_auditor", US_CAPABILITY.EXPORT_READ, true],
    ["member", US_CAPABILITY.READ, false],
    ["owner", [], false],
  ] satisfies [string, UsCapability | readonly UsCapability[], boolean][])(
    "reloads %s permissions for %j",
    harness.phase(async (role, required, allowed) => {
      const { f } = harness;
      await f.pool.query("UPDATE member SET role=$1", [role]);
      const before = await f.snapshot();
      if (allowed) await expect(authorize(required)).resolves.toBe("US_FSMA204_PROCESSOR");
      else
        await expect(authorize(required)).rejects.toMatchObject({
          response: { code: "insufficient_permission" },
        });
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  // Catches denial precedence changing when profile queries are moved before membership.
  it(
    "denies missing membership before missing profile",
    harness.phase(async () => {
      const { f } = harness;
      await f.pool.query("DELETE FROM member");
      await f.pool.query("DELETE FROM traceability_profiles");
      const before = await f.snapshot();
      await expect(authorize()).rejects.toMatchObject({
        response: { code: "insufficient_permission" },
      });
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it.each([
    ["missing profile", "DELETE FROM traceability_profiles", "traceability_profile_required"],
    [
      "baseline",
      "UPDATE traceability_profiles SET baseline_version='invalid'",
      "traceability_profile_invalid",
    ],
    ["code", "UPDATE traceability_profiles SET code='RU_CHZ'", "traceability_profile_invalid"],
    ["timezone", "UPDATE org_profiles SET time_zone='invalid'", "traceability_profile_invalid"],
    [
      "timezone whitespace",
      "UPDATE org_profiles SET time_zone=' America/Los_Angeles '",
      "traceability_profile_invalid",
    ],
    ["missing organization profile", "DELETE FROM org_profiles", "traceability_profile_invalid"],
  ])(
    "preserves %s errors and private target denial",
    harness.phase(async (_kind, query, code) => {
      const { f, context } = harness;
      if (!query) throw new Error("Missing mutation");
      await f.pool.query(query);
      const before = await f.snapshot();
      await expect(authorize()).rejects.toMatchObject({ response: { code } });
      await expect(
        f.db.transaction((tx) => assertUsDemoTarget(tx, f.db, context, denied)),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  // A real foreign tenant has valid profiles but no membership for this actor.
  it(
    "does not borrow membership or profiles across existing tenants",
    harness.phase(async () => {
      const { f, context } = harness;
      const foreign = randomUUID();
      await f.db
        .insert(schema.organization)
        .values({ id: foreign, name: "Synthetic foreign", slug: foreign, createdAt: new Date() });
      await f.pool.query(
        "INSERT INTO traceability_profiles (tenant_id,code,baseline_version,retention_years,effective_at,updated_by_user_id,created_at,updated_at) SELECT $1,code,baseline_version,retention_years,effective_at,updated_by_user_id,created_at,updated_at FROM traceability_profiles WHERE tenant_id=$2",
        [foreign, context.tenantId],
      );
      await f.db
        .insert(schema.orgProfiles)
        .values({ tenantId: foreign, timeZone: "America/Chicago" });
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          authorizeUsMasterData(tx, foreign, context.actorUserId, US_CAPABILITY.READ),
        ),
      ).rejects.toMatchObject({ response: { code: "insufficient_permission" } });
      expect(await f.snapshot()).toEqual(before);
      await f.pool.query("DELETE FROM traceability_profiles WHERE tenant_id=$1", [
        context.tenantId,
      ]);
      const missing = await f.snapshot();
      await expect(authorize()).rejects.toMatchObject({
        response: { code: "traceability_profile_required" },
      });
      expect(await f.snapshot()).toEqual(missing);
      expect(before.traceability_profiles).not.toBe(missing.traceability_profiles);
    }),
  );
  // Same-transaction edits must not be hidden by authority or profile caches.
  it(
    "accepts native retention boundaries and rejects one year at the database boundary",
    harness.phase(async () => {
      const { f } = harness;
      const before = await f.snapshot();
      await expect(
        f.pool.query("UPDATE traceability_profiles SET retention_years=1"),
      ).rejects.toMatchObject({ code: "23514", constraint: "traceability_profiles_retention_min" });
      expect(await f.snapshot()).toEqual(before);
      for (const retention of [2, 2147483647]) {
        await f.pool.query("UPDATE traceability_profiles SET retention_years=$1", [retention]);
        const current = await f.snapshot();
        await expect(authorize()).resolves.toBe("US_FSMA204_PROCESSOR");
        expect(await f.snapshot()).toEqual(current);
      }
    }),
  );
  it(
    "reloads own role, profile and timezone edits on each invocation",
    harness.phase(async () => {
      const { f, context } = harness;
      const before = await f.snapshot();
      const rollback = new Error("owned rollback");
      await expect(
        f.db.transaction(async (tx) => {
          const read = () =>
            authorizeUsMasterData(tx, context.tenantId, context.actorUserId, US_CAPABILITY.READ);
          await expect(read()).resolves.toBe("US_FSMA204_PROCESSOR");
          await tx.execute(sql`UPDATE member SET role='member'`);
          await expect(read()).rejects.toMatchObject({
            response: { code: "insufficient_permission" },
          });
          await tx.execute(sql`UPDATE member SET role='owner'`);
          await tx.execute(
            sql`UPDATE traceability_profiles SET code='US_GENERIC_LOT_TRACEABILITY'`,
          );
          await expect(read()).resolves.toBe("US_GENERIC_LOT_TRACEABILITY");
          await expect(assertUsDemoTarget(tx, f.db, context, denied)).rejects.toThrow(
            "us_dataset_target_invalid",
          );
          await tx.execute(sql`UPDATE traceability_profiles SET code='US_FSMA204_PROCESSOR'`);
          await tx.execute(sql`UPDATE org_profiles SET time_zone='America/Chicago'`);
          await expect(read()).resolves.toBe("US_FSMA204_PROCESSOR");
          await expect(assertUsDemoTarget(tx, f.db, context, denied)).rejects.toThrow(
            "us_dataset_target_invalid",
          );
          await tx.execute(sql`UPDATE org_profiles SET time_zone='America/Los_Angeles'`);
          await assertUsDemoTarget(tx, f.db, context, denied);
          await tx.execute(sql`UPDATE traceability_profiles SET baseline_version='invalid'`);
          await expect(read()).rejects.toMatchObject({
            response: { code: "traceability_profile_invalid" },
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  // Locked organization must not mask the earlier missing-profile error.
  it(
    "denies missing profile while organization profile is actually locked",
    harness.phase(async () => {
      const { f, context } = harness;
      await f.pool.query("DELETE FROM traceability_profiles");
      const before = await f.snapshot();
      const blocker = await f.pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT * FROM org_profiles FOR UPDATE");
        await expect(
          f.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout='100ms'`);
            await authorizeUsMasterData(
              tx,
              context.tenantId,
              context.actorUserId,
              US_CAPABILITY.READ,
            );
          }),
        ).rejects.toMatchObject({ response: { code: "traceability_profile_required" } });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  // Observe a real PostgreSQL wait, then prove the later organization row remains unlocked.
  it(
    "does not lock organization while waiting on the earlier profile lock",
    harness.phase(async () => {
      const { f, context } = harness;
      const before = await f.snapshot();
      const blocker = await f.pool.connect();
      let pending: Promise<{ error: unknown }> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT * FROM traceability_profiles FOR UPDATE");
        let backend = 0;
        pending = f.db
          .transaction(async (tx) => {
            const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            backend = result.rows[0]?.pid ?? 0;
            await authorizeUsMasterData(
              tx,
              context.tenantId,
              context.actorUserId,
              US_CAPABILITY.READ,
            );
          })
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );
        const started = performance.now();
        let blocked = false;
        while (!blocked && performance.now() - started < 2000) {
          const result = await blocker.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
            [backend],
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(blocked).toBe(true);
        await blocker.query("SELECT * FROM org_profiles FOR UPDATE NOWAIT");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
      const outcome = await pending;
      if (outcome?.error !== undefined) throw outcome.error;
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  // Removing either share lock would allow the competing update before transaction exit.
  it(
    "holds membership and both profile shares until exit",
    harness.phase(async () => {
      const { f, context } = harness;
      const before = await f.snapshot();
      let release = () => {};
      let reached = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const running = f.db
        .transaction(async (tx) => {
          await authorizeUsMasterData(
            tx,
            context.tenantId,
            context.actorUserId,
            US_CAPABILITY.READ,
          );
          reached();
          await gate;
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      try {
        await Promise.race([
          waiting,
          running.then(({ error }) => {
            throw error ?? new Error("Share holder exited early");
          }),
        ]);
        for (const table of ["member", "traceability_profiles", "org_profiles"]) {
          const writer = await f.pool.connect();
          try {
            await writer.query("BEGIN");
            await writer.query("SET LOCAL lock_timeout='100ms'");
            await expect(writer.query(`SELECT * FROM ${table} FOR UPDATE`)).rejects.toMatchObject({
              code: "55P03",
            });
          } finally {
            await writer.query("ROLLBACK");
            writer.release();
          }
        }
      } finally {
        release();
        await running;
      }
      const outcome = await running;
      if (outcome.error !== undefined) throw outcome.error;
      for (const table of ["member", "traceability_profiles", "org_profiles"])
        await f.pool.query(`SELECT * FROM ${table} FOR UPDATE NOWAIT`);
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it.each(["traceability_profiles", "org_profiles"])(
    "propagates actual %s driver lock timeout through target",
    harness.phase(async (table) => {
      const { f, context } = harness;
      const before = await f.snapshot();
      const blocker = await f.pool.connect();
      type Client = typeof blocker;
      const originals = new Map<Client, Client["query"]>();
      let nativeError: unknown;
      const instrument = (client: Client) => {
        if (originals.has(client)) return;
        const original = client.query;
        originals.set(client, original);
        client.query = new Proxy(original, {
          apply(target, receiver, args) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (!(result instanceof Promise)) return result;
            return result.catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "55P03")
                nativeError = error;
              throw error;
            });
          },
        });
      };
      f.pool.on("acquire", instrument);
      try {
        await blocker.query("BEGIN");
        await blocker.query(`SELECT * FROM ${table} FOR UPDATE`);
        const error: unknown = await f.db
          .transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout='100ms'`);
            await assertUsDemoTarget(tx, f.db, context, denied);
          })
          .then(
            () => undefined,
            (failure: unknown) => failure,
          );
        expect(error).toMatchObject({ cause: { code: "55P03" } });
        expect(nativeError).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error("Missing driver failure");
        expect(error.cause).toBe(nativeError);
      } finally {
        f.pool.off("acquire", instrument);
        for (const [client, original] of originals) client.query = original;
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      expect(await f.snapshot()).toEqual(before);
    }),
  );
});
