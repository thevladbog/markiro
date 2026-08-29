import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { createDb } from "@markiro/db";

/**
 * `chz-export-job.test.ts` mocks `pg-boss` entirely (`vi.mock("pg-boss", ...)`),
 * so its dedup assertions only check that `jobs.module.ts` *calls*
 * `boss.send`/`boss.createQueue` with the right arguments -- they cannot see
 * whether pg-boss itself would actually reject a duplicate. This file makes
 * no such mock: it runs the real `pg-boss` package against a real scratch
 * Postgres database, so it can distinguish "the code asked for dedup" from
 * "dedup happened".
 *
 * Context (review finding on commit 02bc713ba): `pg-boss`'s
 * `create_queue()` SQL function only inserts the `queue` row's `policy`
 * the first time a queue name is created (`ON CONFLICT DO NOTHING`) --
 * `updateQueue` has no support for changing an existing queue's policy
 * either. Every job insert reads its own `policy` column from the *current*
 * `queue.policy` row at send time (see pg-boss v12 `dist/plans.js`,
 * `insertJobs`), and the `stately` policy's uniqueness guarantee is a
 * partial unique index filtered on `job.policy = 'stately'`
 * (`dist/plans.js`'s `job_i3`). So a queue that was ever created under
 * `standard` stays on `standard` forever, no matter what policy later code
 * passes to `createQueue` -- `singletonKey` is accepted on every `send` but
 * never deduplicated, silently.
 *
 * This was not hypothetical: this repo's dev database had `run-chz-export`
 * sitting under `policy = 'standard'` from an earlier version of this branch
 * even after commit 02bc713ba added `policy: "stately"` to the `createQueue`
 * call in `jobs.module.ts`.
 */
const ready = Boolean(process.env.DATABASE_URL);
const QUEUE_NAME = "run-chz-export";

describe.skipIf(!ready)("run-chz-export queue policy: real pg-boss dedup", () => {
  const databaseName = `markiro_chz_export_policy_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let boss: PgBoss | undefined;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
  }, 60_000);

  afterAll(async () => {
    await maintenance.pool.end();
    // The scratch database can only be dropped once nothing is still
    // connected to it -- both `boss.stop` in `afterEach` and this ordering
    // (drop after the maintenance pool is done issuing DDL) matter here.
    const cleanup = createDb(maintenanceUrl);
    await cleanup.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await cleanup.pool.end();
  });

  afterEach(async () => {
    await boss?.stop({ graceful: false }).catch(() => undefined);
    boss = undefined;
  });

  it(
    "dedupes a same-key created job under stately, but silently accepts a duplicate " +
      "under standard -- and createQueue cannot fix an existing queue's policy",
    async () => {
      boss = new PgBoss(scratchUrl.toString());
      boss.on("error", () => undefined);
      await boss.start();

      // Baseline: exactly what jobs.module.ts's RUN_CHZ_EXPORT_QUEUE relies
      // on. A queue created fresh under `stately` rejects a second `created`
      // job for the same singletonKey -- `send` resolves to `null` instead
      // of inserting. This is the assertion that would fail if the
      // `stately` policy (or the singletonKey itself) were ever removed
      // from jobs.module.ts.
      await boss.createQueue(QUEUE_NAME, { policy: "stately" });
      const key = `${randomUUID()}:${randomUUID()}`;
      const first = await boss.send(QUEUE_NAME, { pass: 0 }, { singletonKey: key });
      const second = await boss.send(QUEUE_NAME, { pass: 0 }, { singletonKey: key });
      expect(first).not.toBeNull();
      expect(second).toBeNull();

      // Reproduce the actual dev-database bug on a second queue: create it
      // under `standard` first (pg-boss's default, and what run-chz-export
      // was created under before commit 02bc713ba), then call `createQueue`
      // again with `policy: "stately"` -- exactly the call jobs.module.ts
      // makes on every boot.
      const legacyQueue = `${QUEUE_NAME}-legacy`;
      await boss.createQueue(legacyQueue, { policy: "standard" });
      await boss.createQueue(legacyQueue, { policy: "stately" });

      // Prove createQueue did nothing: the row is still "standard".
      const { rows } = await boss
        .getDb()
        .executeSql("select policy from pgboss.queue where name = $1", [legacyQueue]);
      expect((rows[0] as { policy: string } | undefined)?.policy).toBe("standard");

      // And prove the consequence: singletonKey is silently inert on this
      // queue. Both sends succeed -- no dedup, no error, nothing to notice
      // at runtime.
      const legacyKey = `${randomUUID()}:${randomUUID()}`;
      const legacyFirst = await boss.send(legacyQueue, { pass: 0 }, { singletonKey: legacyKey });
      const legacySecond = await boss.send(legacyQueue, { pass: 0 }, { singletonKey: legacyKey });
      expect(legacyFirst).not.toBeNull();
      expect(legacySecond).not.toBeNull();
    },
    30_000,
  );
});
