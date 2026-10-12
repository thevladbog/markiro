import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createDb } from "@markiro/db";
import {
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  shippingLifecycleReceiptSchema,
  type ShippingDraft,
} from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { describe, expect, it, type TestContext } from "vitest";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import {
  createUsShippingTransactionFixture,
  runShippingNative,
  seedShippingOrigin,
  seedTransformationShippingOrigin,
  shippingConnection,
  type ShippingTransactionFixture,
} from "./support/us-shipping-transaction-fixture";
import {
  abortable,
  barrier,
  connectClient,
  driverCode,
  outcome,
  ownClient,
  startObservation,
  waitBlocked,
  withOwnedWork,
  type CleanupEvidence,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
type Connection = ReturnType<typeof createDb>;
type Target = {
  tenant: string;
  actor: string;
  lot: string;
  shippingDraft: ShippingDraft;
  store: UsShippingStore;
};
type Worker = (connection: Connection) => Promise<unknown>;

async function ownedTest(
  test: TestContext,
  run: (f: ShippingTransactionFixture, signal: AbortSignal) => Promise<void>,
) {
  const observation = startObservation(test, (signal) =>
    withOwnedWork(async (own) => {
      if (!base) throw new Error("Missing isolated US database");
      const f = await createUsShippingTransactionFixture(base);
      own("fixture-dispose", () => f.close());
      await run(f, signal);
    }),
  );
  const readiness = outcome(observation.ready);
  try {
    const result = await observation.running;
    if (result.error) throw result.error;
  } finally {
    await observation.cleanup();
    await readiness;
  }
}

function nativeWorker(
  signal: AbortSignal,
  c: Target,
  shipment: Awaited<ReturnType<typeof readyShipment>>,
  requestId: string,
) {
  let attempts = 0;
  const pids: number[] = [];
  return {
    attempts: () => attempts,
    pids,
    run: (connection: Connection) =>
      runShippingNative(connection, signal, async (tx) => {
        attempts++;
        const pid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]
          ?.pid;
        if (!pid) throw new Error("Missing native PID");
        pids.push(pid);
        return new UsShippingStore(connection.db).finalizeInTransaction(
          tx,
          c.tenant,
          c.actor,
          shipment.saved.id,
          shipment.command,
          requestId,
        );
      }),
  };
}

const publicFinalize =
  (c: Target, shipment: Awaited<ReturnType<typeof readyShipment>>, requestId: string): Worker =>
  (connection) =>
    new UsShippingStore(connection.db).finalize(
      c.tenant,
      c.actor,
      shipment.saved.id,
      shipment.command,
      requestId,
    );

async function shippingState(f: ShippingTransactionFixture, c: Target) {
  return {
    operations: (
      await f.pool.query<{ command: string; operation_key: string; result: unknown }>(
        "SELECT command,operation_key,result FROM shipping_operations WHERE tenant_id=$1 ORDER BY command,operation_key",
        [c.tenant],
      )
    ).rows,
    audits: (
      await f.pool.query<{ body: Record<string, unknown> }>(
        "SELECT to_jsonb(a) AS body FROM tenant_audit_events a WHERE organization_id=$1 AND action LIKE 'traceability.shipping.%' ORDER BY id",
        [c.tenant],
      )
    ).rows.map((r) => r.body),
  };
}

async function assertFinalized(
  f: ShippingTransactionFixture,
  c: Target,
  shipment: Awaited<ReturnType<typeof readyShipment>>,
  value: unknown,
  requestId: string,
) {
  const result = shippingFinalizedRecordSchema.parse(value);
  const state = await shippingState(f, c);
  const audit = state.audits.filter(
    (a) => a.action === "traceability.shipping.finalized" && a.target_id === shipment.saved.id,
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    organization_id: c.tenant,
    actor_user_id: c.actor,
    action: "traceability.shipping.finalized",
    outcome: "success",
    target_type: "traceability_event",
    target_id: shipment.saved.id,
    request_id: requestId,
    before: shipment.saved,
    after: { ...result, lotIds: [c.lot], statusEffects: [] },
  });
  expect(state.operations.filter((o) => o.command === "shipping.finalize")).toContainEqual({
    command: "shipping.finalize",
    operation_key: shipment.command.operationKey,
    result,
  });
}

async function observeWorkerBlocked(
  observer: Connection,
  blocker: number,
  blocked: number,
  worker: ReturnType<typeof outcome>,
  signal: AbortSignal,
) {
  const stop = new AbortController();
  const waiting = outcome(
    waitBlocked(observer, blocker, blocked, AbortSignal.any([signal, stop.signal])),
  );
  try {
    await Promise.race([
      waiting.then(({ error }) => {
        if (error) throw error;
      }),
      worker.then(({ error }) => {
        throw error ?? new Error("shipping_worker_finished_before_observed_block");
      }),
    ]);
  } finally {
    stop.abort(new Error("shipping_lock_observation_finished"));
    await waiting;
  }
}

function responseCode(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("response" in error)) return undefined;
  const response = error.response;
  return response && typeof response === "object" && "code" in response ? response.code : undefined;
}

/** Pause the actual writer after its business locks, then observe its real follower. */
async function race(
  f: ShippingTransactionFixture,
  signal: AbortSignal,
  gateAt: { table: string; event: "INSERT" | "UPDATE"; condition: string },
  leader: Worker,
  follower: Worker,
  expectedWait: "operation" | "lot" | "sorted_lots" = gateAt.table === "shipping_operations"
    ? "operation"
    : "sorted_lots",
) {
  return withOwnedWork(async (own) => {
    const a = shippingConnection(f, own, "leader"),
      b = shippingConnection(f, own, "follower"),
      observer = shippingConnection(f, own, "observer"),
      gatePool = shippingConnection(f, own, "gate");
    const name = `shipping_gate_${randomUUID().replaceAll("-", "")}`,
      key = Math.floor(Math.random() * 1000000000) + 1;
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${gateAt.condition} THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`,
    );
    own("gate-function", async () => {
      await f.pool.query(`DROP FUNCTION ${name}()`);
    });
    await f.pool.query(
      `CREATE TRIGGER ${name} BEFORE ${gateAt.event} ON ${gateAt.table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    own("gate-trigger", async () => {
      await f.pool.query(`DROP TRIGGER ${name} ON ${gateAt.table}`);
    });
    const workers: { leader?: ReturnType<typeof outcome>; follower?: ReturnType<typeof outcome> } =
      {};
    own("worker-drain", async () => {
      await Promise.all([workers.leader, workers.follower]);
    });
    const gate = await connectClient(gatePool.pool);
    ownClient(own, gate, "gate-release-before-drain", () =>
      gate.query("SELECT pg_advisory_unlock($1)", [key]),
    );
    const leaderPid = (await a.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    const followerPid = (await b.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!leaderPid || !followerPid || !gatePid) throw new Error("Missing actual schedule PIDs");
    expect(new Set([leaderPid, followerPid, gatePid]).size).toBe(3);
    await gate.query("SELECT pg_advisory_lock($1)", [key]);
    const first = (workers.leader = outcome(leader(a)));
    await observeWorkerBlocked(observer, gatePid, leaderPid, first, signal);
    const second = (workers.follower = outcome(follower(b)));
    await observeWorkerBlocked(observer, leaderPid, followerPid, second, signal);
    const observed = (
      await observer.pool.query<{
        pid: number;
        state: string;
        wait_event_type: string;
        blocked: boolean;
        query: string;
      }>(
        "SELECT pid,state,wait_event_type,query,$2::int=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
        [followerPid, leaderPid],
      )
    ).rows[0];
    expect(observed).toMatchObject({
      pid: followerPid,
      state: "active",
      wait_event_type: "Lock",
      blocked: true,
    });
    const query = observed?.query;
    if (!query) throw new Error("Missing observed follower SQL");
    if (expectedWait === "operation") {
      expect(query).toMatch(/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)$/i);
    } else {
      expect(query).toContain('from "traceability_lots"');
      expect(query).toMatch(/for update$/);
      if (expectedWait === "sorted_lots")
        expect(query).toMatch(/order by "traceability_lots"\."id" asc for update$/);
      else expect(query).toMatch(/"traceability_lots"\."id" = \$\d+\) for update$/);
    }
    await gate.query("SELECT pg_advisory_unlock($1)", [key]);
    const results = await Promise.all([first, second]);
    console.info("Shipping actual writer schedule", {
      database: f.databaseName,
      table: gateAt.table,
      leaderPid,
      followerPid,
      followerQuery: observed?.query,
      leaderCode: driverCode(results[0].error),
      followerCode: driverCode(results[1].error),
      followerBusinessCode: responseCode(results[1].error),
    });
    return results;
  });
}

async function freshNative(
  f: ShippingTransactionFixture,
  n: ReturnType<typeof nativeWorker>,
  initial: Awaited<ReturnType<typeof outcome>>,
) {
  expect(n.attempts()).toBe(1);
  expect(n.pids).toHaveLength(1);
  if (initial.error) {
    expect(["40001", "40P01"]).toContain(driverCode(initial.error));
    return withOwnedWork((own) => n.run(shippingConnection(f, own, "explicit-fresh-caller-retry")));
  }
  return initial.value;
}

async function readyShipment(c: Target, quantity = "20") {
  const saved = await c.store.createDraft(
    c.tenant,
    c.actor,
    {
      operationKey: randomUUID(),
      draft: { ...c.shippingDraft, items: [{ lotId: c.lot, quantity, unitOfMeasure: "case" }] },
    },
    "prepare-shipment",
  );
  const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
    expectedDraftVersion: 1,
  });
  expect(ready.issues).toEqual([]);
  expect(ready.state).toBe("complete");
  return {
    saved,
    command: {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: ready.inputDigest,
    },
  };
}

async function absentBackends(pids: number[], databaseName: string) {
  if (!base) throw new Error("Missing isolated US database");
  const admin = createDb(base);
  try {
    const rows = await admin.pool.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=$1 OR pid=ANY($2::int[])",
      [databaseName, pids],
    );
    expect(rows.rows).toEqual([]);
    return true;
  } finally {
    await admin.pool.end();
  }
}

describe.skipIf(!base)("Shipping actual PostgreSQL contention and cancellation", () => {
  const cancelled: {
    phase: string;
    observed: boolean;
    aborted: boolean;
    sameReason: boolean;
    workerRejected: boolean;
    rolledBack: boolean;
    disposed: boolean;
    absent: boolean;
    pids: number[];
    cleanupFailures: { phase: string; code: unknown }[];
  }[] = [];
  for (const phase of ["before readiness", "native waiter"] as const) {
    it.fails(
      `runner cancellation rolls back ${phase} before disposing its exact child`,
      { timeout: 5000 },
      async (test) => {
        let observed = false,
          disposed = false,
          rolledBack = false,
          workerRejected = false,
          databaseName = "";
        let cleanupFailures: { phase: string; code: unknown }[] = [];
        const pids: number[] = [];
        const observation = startObservation(test, (signal, ready) =>
          withOwnedWork(
            async (own) => {
              if (!base) throw new Error("Missing isolated US database");
              const f = await createUsShippingTransactionFixture(base);
              databaseName = f.databaseName;
              own("cancel-dispose", async () => {
                await f.close();
                disposed = true;
              });
              const c = await seedShippingOrigin(f);
              const shipment = await readyShipment(c);
              const before = await f.snapshot();
              own("verify-rollback-after-drain", async () => {
                const after = await f.snapshot();
                rolledBack = isDeepStrictEqual(after, before);
                if (!rolledBack)
                  console.info(
                    "Shipping cancellation changed tables",
                    Object.keys(before).filter((name) => before[name] !== after[name]),
                  );
              });
              if (phase === "before readiness") {
                const cleanupClient = await connectClient(f.pool);
                ownClient(own, cleanupClient, "cancel-independent-bad-savepoint", () =>
                  cleanupClient.query("ROLLBACK TO SAVEPOINT missing_cancel_shipping_savepoint"),
                );
                await cleanupClient.query("BEGIN");
              }
              const nat = shippingConnection(f, own, "cancel-native"),
                obs = shippingConnection(f, own, "cancel-observer");
              let worker: ReturnType<typeof outcome> | undefined;
              own("cancel-worker-drain", async () => {
                const finished = await worker;
                workerRejected = finished?.error === test.signal.reason;
              });
              if (phase === "before readiness") {
                worker = outcome(
                  runShippingNative(nat, signal, async (tx) => {
                    const pid = (
                      await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
                    ).rows[0]?.pid;
                    if (!pid) throw new Error("Missing setup PID");
                    pids.push(pid);
                    await new UsShippingStore(nat.db).createDraftInTransaction(
                      tx,
                      c.tenant,
                      c.actor,
                      { operationKey: randomUUID(), draft: c.shippingDraft },
                      "cancel-before-ready",
                    );
                    observed = true;
                    await abortable(barrier().promise, signal);
                  }),
                );
                const result = await worker;
                if (result.error) throw result.error;
              } else {
                const gate = await connectClient(f.pool);
                ownClient(own, gate, "release-lot-before-worker-drain", () =>
                  gate.query("ROLLBACK"),
                );
                await gate.query("BEGIN");
                await gate.query(
                  "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
                  [c.tenant, c.lot],
                );
                const blocker = (
                  await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
                ).rows[0]?.pid;
                const waiter = (
                  await nat.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
                ).rows[0]?.pid;
                if (!blocker || !waiter) throw new Error("Missing cancellation PIDs");
                pids.push(blocker, waiter);
                worker = outcome(
                  runShippingNative(nat, signal, (tx) =>
                    new UsShippingStore(nat.db).finalizeInTransaction(
                      tx,
                      c.tenant,
                      c.actor,
                      shipment.saved.id,
                      shipment.command,
                      "cancel-waiter",
                    ),
                  ),
                );
                await waitBlocked(obs, blocker, waiter, signal);
                observed = true;
                await abortable(ready(), signal);
              }
            },
            (evidence) => {
              cleanupFailures = evidence.cleanupFailures.map(({ phase, error }) => ({
                phase,
                code: driverCode(error),
              }));
            },
          ),
        );
        const readiness = outcome(observation.ready);
        test.onTestFinished(async () => {
          await observation.cleanup();
          await readiness;
          const finished = await observation.running;
          cancelled.push({
            phase,
            observed,
            aborted: test.signal.aborted,
            sameReason: finished.error === test.signal.reason,
            workerRejected,
            rolledBack,
            disposed,
            absent: await absentBackends(pids, databaseName),
            pids,
            cleanupFailures,
          });
          console.info("Shipping actual runner cancellation", cancelled.at(-1));
        });
        const first = await readiness;
        if (first.error) throw first.error;
        const finished = await observation.running;
        if (finished.error) throw finished.error;
      },
    );
  }

  it("proves cancellation reached its intended phases, rejects actual workers, rolls back and removes every owned backend", () => {
    expect(cancelled).toEqual([
      {
        phase: "before readiness",
        observed: true,
        aborted: true,
        sameReason: true,
        workerRejected: true,
        rolledBack: true,
        disposed: true,
        absent: true,
        pids: [expect.any(Number)],
        cleanupFailures: [{ phase: "cancel-independent-bad-savepoint", code: "3B001" }],
      },
      {
        phase: "native waiter",
        observed: true,
        aborted: true,
        sameReason: true,
        workerRejected: true,
        rolledBack: true,
        disposed: true,
        absent: true,
        pids: [expect.any(Number), expect.any(Number)],
        cleanupFailures: [],
      },
    ]);
    expect(cancelled.every((row) => row.pids.every((pid) => pid > 0))).toBe(true);
  });

  it("preserves the original setup failure through an independent real SQL cleanup error and exact backend disposal", async (test) => {
    const primary = new Error("shipping_failure_before_readiness");
    let evidence: CleanupEvidence | undefined,
      disposed = false,
      destroyed = false,
      pid = 0,
      databaseName = "";
    const observation = startObservation(test, () =>
      withOwnedWork(
        async (own) => {
          if (!base) throw new Error("Missing isolated US database");
          const f = await createUsShippingTransactionFixture(base);
          databaseName = f.databaseName;
          own("fixture-dispose", async () => {
            await f.close();
            disposed = true;
          });
          const client = await connectClient(f.pool);
          ownClient(
            own,
            client,
            "bad-savepoint",
            () => client.query("ROLLBACK TO SAVEPOINT missing_owned_shipping_savepoint"),
            () => {
              client.release(true);
              destroyed = true;
            },
          );
          await client.query("BEGIN");
          pid =
            (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ??
            0;
          throw primary;
        },
        (reported) => {
          evidence = reported;
        },
      ),
    );
    const readiness = outcome(observation.ready);
    try {
      expect((await readiness).error).toBe(primary);
      expect((await observation.running).error).toBe(primary);
      expect(evidence?.primaryError).toBe(primary);
      expect(evidence?.cleanupFailures).toHaveLength(1);
      expect(evidence?.cleanupFailures[0]?.phase).toBe("bad-savepoint");
      expect(driverCode(evidence?.cleanupFailures[0]?.error)).toBe("3B001");
      expect(disposed && destroyed).toBe(true);
      expect(pid).toBeGreaterThan(0);
      await absentBackends([pid], databaseName);
    } finally {
      await observation.cleanup();
      await readiness;
    }
  });

  it.for(["native", "public"] as const)(
    "arbitrates the same create operation with %s holding its actual operation lock",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        const c = await seedShippingOrigin(f),
          input = { operationKey: randomUUID(), draft: c.shippingDraft };
        expect(
          (
            await f.pool.query("SELECT sequence FROM shipping_counters WHERE tenant_id=$1", [
              c.tenant,
            ])
          ).rows,
        ).toEqual([]);
        let attempts = 0;
        const native: Worker = (connection) =>
          runShippingNative(connection, signal, (tx) => {
            attempts++;
            return new UsShippingStore(connection.db).createDraftInTransaction(
              tx,
              c.tenant,
              c.actor,
              input,
              "native-create-race",
            );
          });
        const pub: Worker = (connection) =>
          new UsShippingStore(connection.db).createDraft(
            c.tenant,
            c.actor,
            input,
            "public-create-race",
          );
        const results = await race(
          f,
          signal,
          {
            table: "shipping_operations",
            event: "INSERT",
            condition: `NEW.tenant_id='${c.tenant}' AND NEW.command='shipping.create'`,
          },
          winner === "native" ? native : pub,
          winner === "native" ? pub : native,
        );
        const nat = results[winner === "native" ? 0 : 1],
          publicResult = results[winner === "native" ? 1 : 0];
        expect(attempts).toBe(1);
        expect(publicResult.error).toBeUndefined();
        if (nat.error) expect(["40001", "40P01"]).toContain(driverCode(nat.error));
        const recovered = nat.error
          ? await withOwnedWork((own) =>
              native(shippingConnection(f, own, "create-caller-fresh-retry")),
            )
          : nat.value;
        expect(recovered).toEqual(publicResult.value);
        const state = await shippingState(f, c);
        expect(state.operations).toEqual([
          { command: "shipping.create", operation_key: input.operationKey, result: recovered },
        ]);
        expect(state.audits).toHaveLength(1);
        const created = shippingDraftRecordSchema.parse(recovered);
        expect(
          (
            await f.pool.query(
              "SELECT sequence::text AS sequence FROM shipping_counters WHERE tenant_id=$1",
              [c.tenant],
            )
          ).rows,
        ).toEqual([{ sequence: "1" }]);
        expect(
          (
            await f.pool.query(
              "SELECT id,event_number,pending_draft_id,current_event_id,lifecycle_version,next_revision FROM shipping_event_roots WHERE tenant_id=$1",
              [c.tenant],
            )
          ).rows,
        ).toEqual([
          {
            id: created.id,
            event_number: created.eventNumber,
            pending_draft_id: created.id,
            current_event_id: null,
            lifecycle_version: 1,
            next_revision: 2,
          },
        ]);
        expect(
          (
            await f.pool.query(
              "SELECT id,root_event_id,status,revision,draft_version FROM traceability_events WHERE tenant_id=$1 AND type='shipping'",
              [c.tenant],
            )
          ).rows,
        ).toEqual([
          {
            id: created.id,
            root_event_id: created.id,
            status: "draft",
            revision: 1,
            draft_version: 1,
          },
        ]);
        expect(
          (
            await f.pool.query(
              "SELECT (SELECT count(*)::int FROM shipping_event_details WHERE tenant_id=$1) AS details,(SELECT count(*)::int FROM shipping_event_items WHERE tenant_id=$1) AS items,(SELECT count(*)::int FROM shipping_event_documents WHERE tenant_id=$1) AS documents",
              [c.tenant],
            )
          ).rows,
        ).toEqual([{ details: 1, items: 1, documents: 1 }]);
        expect(state.audits[0]).toMatchObject({
          organization_id: c.tenant,
          actor_user_id: c.actor,
          action: "traceability.shipping.draft_created",
          outcome: "success",
          target_type: "traceability_event",
          target_id: created.id,
          request_id: winner === "native" ? "native-create-race" : "public-create-race",
          before: null,
          after: recovered,
        });
        const before = await f.snapshot();
        expect(await c.store.createDraft(c.tenant, c.actor, input, "post-race-replay")).toEqual(
          recovered,
        );
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.for(["native", "public"] as const)(
    "converges the same finalize operation with %s holding root, lot and receipt locks",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        const c = await seedShippingOrigin(f),
          shipment = await readyShipment(c),
          n = nativeWorker(signal, c, shipment, "native-final-race"),
          p = publicFinalize(c, shipment, "public-final-race");
        const results = await race(
          f,
          signal,
          {
            table: "shipping_operations",
            event: "INSERT",
            condition: `NEW.tenant_id='${c.tenant}' AND NEW.command='shipping.finalize'`,
          },
          winner === "native" ? n.run : p,
          winner === "native" ? p : n.run,
        );
        const native = await freshNative(f, n, results[winner === "native" ? 0 : 1]),
          pub = results[winner === "native" ? 1 : 0];
        expect(pub.error).toBeUndefined();
        expect(native).toEqual(pub.value);
        await assertFinalized(
          f,
          c,
          shipment,
          native,
          winner === "native" ? "native-final-race" : "public-final-race",
        );
        const state = await shippingState(f, c);
        expect(state.operations).toHaveLength(2);
        expect(state.audits).toHaveLength(2);
        expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject({
          balance: { state: "known", supply: "100", used: "20", remaining: "80" },
        });
      }),
  );

  it.for(["receiving", "transformation"] as const)(
    "prevents 80 plus 30 overship on a real %s origin after PID-observed public/native contention",
    async (origin, test) =>
      ownedTest(test, async (f, signal) => {
        for (const winner of ["native", "public"] as const) {
          const c =
            origin === "receiving"
              ? await seedShippingOrigin(f)
              : await seedTransformationShippingOrigin(f);
          const first = await readyShipment(c, "80"),
            second = await readyShipment(c, "30");
          const native = nativeWorker(
            signal,
            c,
            winner === "native" ? first : second,
            winner === "native" ? "native-80" : "native-30",
          );
          const pub = publicFinalize(
            c,
            winner === "native" ? second : first,
            winner === "native" ? "public-30" : "public-80",
          );
          const results = await race(
            f,
            signal,
            {
              table: "shipping_event_items",
              event: "UPDATE",
              condition: `NEW.event_id='${first.saved.id}' AND NEW.tlc_snapshot IS NOT NULL`,
            },
            winner === "native" ? native.run : pub,
            winner === "native" ? pub : native.run,
          );
          expect(results[0].error).toBeUndefined();
          expect(native.attempts()).toBe(1);
          expect(native.pids).toHaveLength(1);
          if (winner === "native") {
            expect(results[1].error).toMatchObject({
              response: {
                code: "event_incomplete",
                issues: expect.arrayContaining([
                  expect.objectContaining({ code: "over_shipment" }),
                ]),
              },
            });
          } else {
            // Auth established an RR snapshot before the 80-case holder committed.
            expect(driverCode(results[1].error)).toBe("40001");
            const before = await f.snapshot();
            await expect(
              withOwnedWork((own) => native.run(shippingConnection(f, own, "fresh-30-denied"))),
            ).rejects.toMatchObject({
              response: {
                code: "event_incomplete",
                issues: expect.arrayContaining([
                  expect.objectContaining({ code: "over_shipment" }),
                ]),
              },
            });
            expect(await f.snapshot()).toEqual(before);
          }
          const ready = await c.store.checkReadiness(c.tenant, c.actor, second.saved.id, {
            expectedDraftVersion: 1,
          });
          expect(ready).toMatchObject({
            state: "incomplete",
            issues: expect.arrayContaining([expect.objectContaining({ code: "over_shipment" })]),
          });
          expect((await c.store.getRecord(c.tenant, c.actor, second.saved.id)).status).toBe(
            "draft",
          );
          await assertFinalized(
            f,
            c,
            first,
            results[0].value,
            winner === "native" ? "native-80" : "public-80",
          );
          const state = await shippingState(f, c);
          expect(state.operations.filter((o) => o.command === "shipping.finalize")).toHaveLength(1);
          expect(
            state.audits.filter((a) => a.action === "traceability.shipping.finalized"),
          ).toHaveLength(1);
          expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject({
            balance: { state: "known", supply: "100", used: "80", remaining: "20" },
          });
        }
      }),
  );

  it("blocks public amendment-draft void behind a native draft read, preserves its read and freezes original history", async (test) =>
    ownedTest(test, async (f, signal) => {
      const c = await seedShippingOrigin(f),
        shipment = await readyShipment(c);
      const original = await c.store.finalize(
        c.tenant,
        c.actor,
        shipment.saved.id,
        shipment.command,
        "before-amendment",
      );
      const amendment = await c.store.amend(
        c.tenant,
        c.actor,
        original.id,
        { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Review dispatch" },
        "public-amendment",
      );
      const frozen = (
        await f.pool.query<{ bytes: string }>(
          "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE id=$1",
          [original.id],
        )
      ).rows[0]?.bytes;
      const beforeVoid = await c.store.getRecord(c.tenant, c.actor, amendment.eventId);
      const voidReceipt = await withOwnedWork(async (own) => {
        const nat = shippingConnection(f, own, "native-reader"),
          pub = shippingConnection(f, own, "public-draft-void"),
          observer = shippingConnection(f, own, "read-observer");
        const arrived = barrier(),
          release = barrier();
        const workers: { read?: ReturnType<typeof outcome>; void?: ReturnType<typeof outcome> } =
          {};
        own("read-workers-drain", async () => {
          await Promise.all([workers.read, workers.void]);
        });
        own("read-release-before-drain", async () => {
          release.release();
        });
        const readerPid = (await nat.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        const voidPid = (await pub.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (!readerPid || !voidPid) throw new Error("Missing reader/lifecycle PIDs");
        workers.read = outcome(
          runShippingNative(nat, signal, async (tx) => {
            const record = await new UsShippingStore(nat.db).getRecordInTransaction(
              tx,
              c.tenant,
              c.actor,
              amendment.eventId,
            );
            expect(record).toEqual(beforeVoid);
            arrived.release();
            await abortable(release.promise, signal);
            expect(
              await new UsShippingStore(nat.db).getRecordInTransaction(
                tx,
                c.tenant,
                c.actor,
                amendment.eventId,
              ),
            ).toEqual(record);
            return record;
          }),
        );
        await abortable(arrived.promise, signal);
        workers.void = outcome(
          new UsShippingStore(pub.db).void(
            c.tenant,
            c.actor,
            amendment.eventId,
            {
              operationKey: randomUUID(),
              expectedLifecycleVersion: 3,
              expectedDraftVersion: 1,
              reason: "Cancel review",
            },
            "public-pending-void",
          ),
        );
        await waitBlocked(observer, readerPid, voidPid, signal);
        const blockedSql = (
          await observer.pool.query<{ query: string }>(
            "SELECT query FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()",
            [voidPid],
          )
        ).rows[0]?.query;
        expect(blockedSql).toContain('from "shipping_event_roots"');
        expect(blockedSql).toMatch(/for update$/);
        release.release();
        const [read, removed] = await Promise.all([workers.read, workers.void]);
        expect(read.error).toBeUndefined();
        expect(removed.error).toBeUndefined();
        expect(removed.value).toMatchObject({
          record: { status: "void", draft: beforeVoid.draft },
        });
        return shippingLifecycleReceiptSchema.parse(removed.value);
      });
      const historical = await c.store.getRecord(c.tenant, c.actor, original.id);
      expect(historical).toMatchObject({
        status: "finalized",
        snapshot: original.snapshot,
        lifecycle: { currentEventId: original.id, pendingDraftId: null, lifecycleVersion: 4 },
      });
      expect(
        (
          await f.pool.query<{ bytes: string }>(
            "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE id=$1",
            [original.id],
          )
        ).rows[0]?.bytes,
      ).toBe(frozen);
      expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject({
        balance: { supply: "100", used: "20", remaining: "80" },
      });
      const state = await shippingState(f, c);
      expect(state.operations).toHaveLength(4);
      expect(state.audits).toHaveLength(4);
      const voidAudit = state.audits.find((a) => a.action === "traceability.shipping.voided");
      expect(voidAudit).toMatchObject({
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.shipping.voided",
        outcome: "success",
        target_type: "traceability_event",
        target_id: amendment.eventId,
        request_id: "public-pending-void",
      });
      expect(voidAudit?.before).toEqual(beforeVoid);
      expect(voidAudit?.after).toEqual({
        rootId: original.id,
        revision: 2,
        reason: "Cancel review",
        result: "voided",
        record: voidReceipt.record,
      });
      const amendAudit = state.audits.find(
        (a) => a.action === "traceability.shipping.amendment_started",
      );
      expect(amendAudit).toMatchObject({
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.shipping.amendment_started",
        outcome: "success",
        target_type: "traceability_event",
        target_id: amendment.eventId,
        request_id: "public-amendment",
      });
      expect(amendAudit?.before).toEqual(original);
      expect(amendAudit?.after).toEqual({
        rootId: original.id,
        revision: 2,
        reason: "Review dispatch",
        result: "draft_started",
        record: amendment.record,
      });
    }));

  it("keeps historical multi-reads on one RR snapshot while public amendment commits", async (test) =>
    ownedTest(test, async (f, signal) => {
      const c = await seedShippingOrigin(f),
        shipment = await readyShipment(c);
      const original = await c.store.finalize(
        c.tenant,
        c.actor,
        shipment.saved.id,
        shipment.command,
        "history-before-amend",
      );
      await withOwnedWork(async (own) => {
        const connection = shippingConnection(f, own, "historical-rr");
        await runShippingNative(connection, signal, async (tx) => {
          const first = await c.store.getRecordInTransaction(tx, c.tenant, c.actor, original.id);
          expect(first).toEqual(original);
          const amendment = await c.store.amend(
            c.tenant,
            c.actor,
            original.id,
            { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Metadata review" },
            "history-public-amend",
          );
          expect(amendment.record).toMatchObject({
            status: "draft",
            lifecycle: {
              pendingDraftId: amendment.eventId,
              currentEventId: original.id,
              lifecycleVersion: 3,
            },
          });
          expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, original.id)).toEqual(
            first,
          );
        });
      });
      expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
        snapshot: original.snapshot,
        lifecycle: { lifecycleVersion: 3 },
      });
    }));

  it("public current balance waits for the native lot holder and reads only committed stock", async (test) =>
    ownedTest(test, async (f, signal) => {
      const c = await seedShippingOrigin(f),
        shipment = await readyShipment(c, "80"),
        n = nativeWorker(signal, c, shipment, "native-balance-holder");
      const results = await race(
        f,
        signal,
        {
          table: "shipping_event_items",
          event: "UPDATE",
          condition: `NEW.event_id='${shipment.saved.id}' AND NEW.tlc_snapshot IS NOT NULL`,
        },
        n.run,
        (connection) =>
          new UsShippingStore(connection.db).getLotShippingBalance(c.tenant, c.actor, c.lot, {}),
        "lot",
      );
      expect(results[0].error).toBeUndefined();
      expect(results[1].error).toBeUndefined();
      expect(results[1].value).toMatchObject({
        balance: { state: "known", supply: "100", used: "80", remaining: "20" },
      });
      await assertFinalized(f, c, shipment, results[0].value, "native-balance-holder");
    }));

  it("public finalized Shipping void restores stock before a fresh native readiness decision and retains receipt bytes", async (test) =>
    ownedTest(test, async (f, signal) => {
      const c = await seedShippingOrigin(f),
        first = await readyShipment(c, "80");
      const original = await c.store.finalize(
        c.tenant,
        c.actor,
        first.saved.id,
        first.command,
        "void-original-finalize",
      );
      const second = await readyShipment(c, "20"),
        n = nativeWorker(signal, c, second, "native-after-shipping-void");
      const command = {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Dispatch withdrawn",
      };
      const results = await race(
        f,
        signal,
        {
          table: "traceability_events",
          event: "UPDATE",
          condition: `NEW.id='${original.id}' AND NEW.status='void'`,
        },
        (connection) =>
          new UsShippingStore(connection.db).void(
            c.tenant,
            c.actor,
            original.id,
            command,
            "public-stock-void",
          ),
        n.run,
      );
      expect(results[0].error).toBeUndefined();
      expect(n.attempts()).toBe(1);
      expect(driverCode(results[1].error)).toBe("40001");
      const before = await f.snapshot();
      await expect(
        withOwnedWork((own) => n.run(shippingConnection(f, own, "stale-ready-after-void"))),
      ).rejects.toMatchObject({ response: { code: "shipping_readiness_changed" } });
      expect(await f.snapshot()).toEqual(before);
      const ready = await c.store.checkReadiness(c.tenant, c.actor, second.saved.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      const fresh = {
        ...second,
        command: { ...second.command, expectedInputDigest: ready.inputDigest },
      };
      const retry = nativeWorker(signal, c, fresh, "fresh-ready-after-void");
      const finalized = await withOwnedWork((own) =>
        retry.run(shippingConnection(f, own, "fresh-ready-finalize")),
      );
      await assertFinalized(f, c, fresh, finalized, "fresh-ready-after-void");
      expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
        status: "void",
        snapshot: original.snapshot,
      });
      const unchanged = await f.snapshot();
      expect(
        await c.store.finalize(
          c.tenant,
          c.actor,
          original.id,
          first.command,
          "historical-finalize-replay",
        ),
      ).toEqual(original);
      expect(
        await c.store.void(c.tenant, c.actor, original.id, command, "historical-void-replay"),
      ).toEqual(results[0].value);
      expect(await f.snapshot()).toEqual(unchanged);
      expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject({
        balance: { supply: "100", used: "20", remaining: "80" },
      });
      const state = await shippingState(f, c);
      expect(state.operations).toHaveLength(5);
      expect(state.audits).toHaveLength(5);
      const voidAudit = state.audits.find((a) => a.action === "traceability.shipping.voided");
      expect(voidAudit).toMatchObject({
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.shipping.voided",
        outcome: "success",
        target_type: "traceability_event",
        target_id: original.id,
        request_id: "public-stock-void",
      });
      expect(voidAudit?.before).toEqual(original);
      expect(voidAudit?.after).toEqual({
        rootId: original.id,
        revision: 1,
        reason: "Dispatch withdrawn",
        result: "voided",
        record: shippingLifecycleReceiptSchema.parse(results[0].value).record,
      });
    }));

  it("manual recall owns the lot before amendment finalize and invalidates only the automatic status effect", async (test) =>
    ownedTest(test, async (f, signal) => {
      const c = await seedShippingOrigin(f),
        full = await readyShipment(c, "100");
      const original = await c.store.finalize(
        c.tenant,
        c.actor,
        full.saved.id,
        full.command,
        "full-before-recall",
      );
      const amended = await c.store.amend(
        c.tenant,
        c.actor,
        original.id,
        { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Revise count" },
        "before-status-amend",
      );
      const ready = await c.store.checkReadiness(c.tenant, c.actor, amended.eventId, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      if (amended.record.status !== "draft") throw new Error("Missing amendment draft");
      const shipment = {
        saved: amended.record,
        command: {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
      };
      const lotStore = new UsLotStore(f.db),
        lotBefore = await lotStore.getLot(c.tenant, c.actor, c.lot);
      const n = nativeWorker(signal, c, shipment, "native-after-recall");
      const results = await race(
        f,
        signal,
        {
          table: "traceability_lots",
          event: "UPDATE",
          condition: `NEW.id='${c.lot}' AND NEW.status='recalled'`,
        },
        (connection) =>
          new UsLotStore(connection.db).changeStatus(
            c.tenant,
            c.actor,
            c.lot,
            { status: "recalled", reason: "Manual recall", expectedRevision: lotBefore.revision },
            "public-manual-recall",
          ),
        n.run,
      );
      expect(results[0].error).toBeUndefined();
      expect(n.attempts()).toBe(1);
      expect(driverCode(results[1].error)).toBe("40001");
      const before = await f.snapshot();
      await expect(
        withOwnedWork((own) => n.run(shippingConnection(f, own, "fresh-recall-denied"))),
      ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
      expect(await f.snapshot()).toEqual(before);
      const recalled = await lotStore.getLot(c.tenant, c.actor, c.lot);
      expect(recalled).toMatchObject({ status: "recalled", revision: lotBefore.revision + 1 });
      const effects = (
        await f.pool.query(
          "SELECT event_id,prior_status,new_status,compensated_at,compensation_reason FROM shipping_lot_status_effects WHERE tenant_id=$1 AND lot_id=$2",
          [c.tenant, c.lot],
        )
      ).rows;
      expect(effects).toEqual([
        {
          event_id: original.id,
          prior_status: "active",
          new_status: "shipped",
          compensated_at: expect.any(Date),
          compensation_reason: "Manual recall",
        },
      ]);
      expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
        snapshot: original.snapshot,
      });
      const audit = (
        await f.pool.query<{ body: Record<string, unknown> }>(
          "SELECT to_jsonb(a) AS body FROM tenant_audit_events a WHERE organization_id=$1 AND request_id='public-manual-recall'",
          [c.tenant],
        )
      ).rows;
      expect(audit).toEqual([
        {
          body: expect.objectContaining({
            organization_id: c.tenant,
            actor_user_id: c.actor,
            action: "traceability.lot.status_changed",
            target_type: "traceability_lot",
            target_id: c.lot,
            outcome: "success",
            request_id: "public-manual-recall",
            before: lotBefore,
            after: { ...recalled, reason: "Manual recall" },
          }),
        },
      ]);
    }));

  it.for(["receiving", "transformation"] as const)(
    "serializes public %s origin void with native Shipping without locking upstream roots after lots",
    async (kind, test) =>
      ownedTest(test, async (f, signal) => {
        for (const first of ["shipping", "origin"] as const) {
          const c =
            kind === "receiving"
              ? await seedShippingOrigin(f)
              : await seedTransformationShippingOrigin(f);
          const originId = c.origin.id;
          if (kind === "receiving" && first === "shipping") {
            // Reproduce the two malformed fixture payloads that completed before
            // PID observation in the earlier ordinary timeout runs.
            for (const commandVersion of [undefined, 2]) {
              const before = await f.snapshot();
              const failure: unknown = await new UsReceivingStore(f.db)
                .void(
                  c.tenant,
                  c.actor,
                  originId,
                  {
                    ...(commandVersion === undefined ? {} : { commandVersion }),
                    operationKey: randomUUID(),
                    expectedLifecycleVersion: 2,
                    reason: "Invalid origin",
                  },
                  "diagnose-malformed-public-void",
                )
                .catch((error: unknown) => error);
              expect(failure).toMatchObject({
                status: 400,
                response: {
                  code: "invalid_master_data",
                  issues: expect.arrayContaining([
                    expect.objectContaining({ path: "expectedDraftVersion" }),
                  ]),
                },
              });
              console.info("Receiving origin malformed public writer diagnostic", {
                commandVersion,
                code: responseCode(failure),
              });
              expect(await f.snapshot()).toEqual(before);
            }
          }
          const frozen = (
            await f.pool.query<{ bytes: string }>(
              "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE id=$1",
              [originId],
            )
          ).rows[0]?.bytes;
          const shipment = await readyShipment(c),
            n = nativeWorker(signal, c, shipment, "native-origin-race");
          const key = randomUUID();
          const voidOrigin: Worker = (connection) =>
            kind === "receiving"
              ? new UsReceivingStore(connection.db).void(
                  c.tenant,
                  c.actor,
                  originId,
                  {
                    commandVersion: 2,
                    operationKey: key,
                    expectedLifecycleVersion: 2,
                    expectedDraftVersion: null,
                    reason: "Invalid origin",
                  },
                  "public-origin-void",
                )
              : new UsTransformationStore(connection.db).void(
                  c.tenant,
                  c.actor,
                  originId,
                  { operationKey: key, expectedLifecycleVersion: 2, reason: "Invalid origin" },
                  "public-origin-void",
                );
          const results = await race(
            f,
            signal,
            first === "shipping"
              ? {
                  table: "shipping_event_items",
                  event: "UPDATE",
                  condition: `NEW.event_id='${shipment.saved.id}' AND NEW.tlc_snapshot IS NOT NULL`,
                }
              : {
                  table: "traceability_events",
                  event: "UPDATE",
                  condition: `NEW.id='${originId}' AND NEW.status='void'`,
                },
            first === "shipping" ? n.run : voidOrigin,
            first === "shipping" ? voidOrigin : n.run,
            first === "shipping" && kind === "receiving" ? "lot" : "sorted_lots",
          );
          expect(results[0].error).toBeUndefined();
          expect(n.attempts()).toBe(1);
          if (first === "shipping") {
            expect(results[1].error).toMatchObject({
              response: { code: "traceability_downstream_blocked" },
            });
            await assertFinalized(f, c, shipment, results[0].value, "native-origin-race");
            expect(await c.store.getLotShippingBalance(c.tenant, c.actor, c.lot, {})).toMatchObject(
              { balance: { supply: "100", used: "20", remaining: "80" } },
            );
          } else {
            expect(driverCode(results[1].error)).toBe("40001");
            const before = await f.snapshot();
            await expect(
              withOwnedWork((own) => n.run(shippingConnection(f, own, "fresh-origin-gap-denied"))),
            ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
            expect(await f.snapshot()).toEqual(before);
            expect((await c.store.getRecord(c.tenant, c.actor, shipment.saved.id)).status).toBe(
              "draft",
            );
            const state = await shippingState(f, c);
            expect(state.operations.filter((o) => o.command === "shipping.finalize")).toEqual([]);
            expect(
              state.audits.filter((a) => a.action === "traceability.shipping.finalized"),
            ).toEqual([]);
          }
          expect(
            (
              await f.pool.query<{ bytes: string }>(
                "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE id=$1",
                [originId],
              )
            ).rows[0]?.bytes,
          ).toBe(frozen);
        }
      }),
  );
});
