import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  seedFinalizableTransformation,
  transformationEffects,
} from "./support/us-transformation-finalization-fixture";

const base = process.env.US_TEST_DATABASE_URL;

import {
  barrier,
  outcome,
  abortable,
  startObservation,
  waitBlocked,
  waitOwnedBackendsGone,
  driverCode,
  connectClient,
  ownClient,
  withOwnedWork,
  type OwnCleanup,
  type OwnedClient,
  type CleanupEvidence,
} from "./support/us-transformation-lock-fixture";

describe.skipIf(!base)("Native Transformation actual PostgreSQL locks", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
    console.info(`Owned Transformation lock database: ${f.databaseName}`);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it.for(["release", "cancel"] as const)(
    "waits for an actually held backend before %s completion",
    async (mode, test) => {
      const client = await connectClient(f.pool);
      let released = false;
      const close = () => {
        if (!released) {
          released = true;
          client.release(true);
        }
      };
      test.onTestFinished(close);
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      if (!pid) throw new Error("Missing held backend identity");
      const firstProbe = barrier();
      const query = new Proxy(f.pool.query, {
        apply(target, receiver, args) {
          const pending: unknown = Reflect.apply(target, receiver, args);
          if (pending instanceof Promise) void pending.then(firstProbe.release, firstProbe.release);
          return pending;
        },
      });
      const observer = new Proxy(f.pool, {
        get(target, key, receiver) {
          return key === "query" ? query : Reflect.get(target, key, receiver);
        },
      });
      const injected = new AbortController();
      const failure = new Error("held_backend_poll_cancel");
      let settled = false;
      const waiting = outcome(
        waitOwnedBackendsGone(
          { pool: observer },
          [pid],
          AbortSignal.any([test.signal, injected.signal]),
        ),
      ).then((result) => {
        settled = true;
        return result;
      });
      try {
        await abortable(firstProbe.promise, test.signal);
        await nextTurn();
        expect(settled).toBe(false);
        if (mode === "cancel") {
          injected.abort(failure);
          expect((await waiting).error).toBe(failure);
        }
        close();
        if (mode === "release") expect((await waiting).error).toBeUndefined();
        await waitOwnedBackendsGone(f, [pid], test.signal);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
              [pid],
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        close();
        await waiting;
      }
    },
  );

  it.for(["cancellation", "query-failure"] as const)(
    "propagates owned backend absence %s without hiding failure",
    async (mode, test) => {
      const injected = new AbortController();
      const failure = new Error("owned_backend_absence_" + mode);
      let queries = 0;
      const observer = new Proxy(f.pool, {
        get(target, key, receiver) {
          if (key !== "query") return Reflect.get(target, key, receiver);
          return () => {
            queries++;
            throw failure;
          };
        },
      });
      if (mode === "cancellation") injected.abort(failure);
      const result = await outcome(
        waitOwnedBackendsGone(
          { pool: observer },
          [1],
          AbortSignal.any([test.signal, injected.signal]),
        ),
      );
      expect(result.error).toBe(failure);
      expect(queries).toBe(mode === "cancellation" ? 0 : 1);
    },
  );

  it.for(["unlock", "rollback"] as const)(
    "retains primary failure and releases all owned resources after real %s cleanup SQL rejection",
    async (mode, test) => {
      if (!base) throw new Error("Missing isolated database");
      const url = new URL(base);
      url.pathname = "/" + f.databaseName;
      let gatePool: ReturnType<typeof createDb> | undefined;
      let workerPool: ReturnType<typeof createDb> | undefined;
      const primary = new Error("owned_primary_failure_" + mode);
      const key = Math.floor(Math.random() * 1000000000) + 1;
      let gate: OwnedClient | undefined;
      let gateDestroyed = false,
        gateEnded = false,
        workerEnded = false,
        drained = false;
      let evidence: CleanupEvidence | undefined;
      let pending: ReturnType<typeof outcome> | undefined;
      let gatePid = 0,
        workerPid = 0;
      const destroy = () => {
        if (gate && !gateDestroyed) {
          gateDestroyed = true;
          gate.release(true);
        }
      };
      const endGate = async () => {
        if (gatePool && !gateEnded) {
          gateEnded = true;
          await gatePool.pool.end();
        }
      };
      const endWorker = async () => {
        if (workerPool && !workerEnded) {
          workerEnded = true;
          await workerPool.pool.end();
        }
      };
      const rescue = async () => {
        destroy();
        await pending;
        await Promise.all([endWorker(), endGate()]);
      };
      test.onTestFinished(rescue);
      try {
        const actual = await outcome(
          withOwnedWork(
            async (own) => {
              const ownedGatePool = createDb(url.toString(), { max: 1, statement_timeout: 5000 });
              gatePool = ownedGatePool;
              own("gate-pool-end", endGate);
              const ownedWorkerPool = createDb(url.toString(), { max: 1, statement_timeout: 5000 });
              workerPool = ownedWorkerPool;
              own("worker-pool-end", endWorker);
              own("actual-worker-drain", async () => {
                await pending;
                drained = true;
              });
              gate = await connectClient(ownedGatePool.pool);
              const held = gate;
              ownClient(
                own,
                held,
                mode,
                () =>
                  mode === "unlock"
                    ? held.query("SELECT pg_advisory_unlock($1)", [key])
                    : held.query("ROLLBACK TO SAVEPOINT no_such_owned_savepoint"),
                destroy,
              );
              gatePid =
                (await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                  ?.pid ?? 0;
              workerPid =
                (
                  await ownedWorkerPool.pool.query<{ pid: number }>(
                    "SELECT pg_backend_pid() AS pid",
                  )
                ).rows[0]?.pid ?? 0;
              expect(gatePid).toBeGreaterThan(0);
              expect(workerPid).toBeGreaterThan(0);
              await held.query("SELECT pg_advisory_lock($1)", [key]);
              pending = outcome(
                ownedWorkerPool.pool.query("SELECT pg_advisory_xact_lock($1)", [key]),
              );
              await waitBlocked(
                { ...ownedGatePool, pool: f.pool },
                gatePid,
                workerPid,
                test.signal,
              );
              await held.query("BEGIN");
              if (mode === "unlock") {
                const injected = await outcome(held.query("SELECT 1/0"));
                expect(driverCode(injected.error)).toBe("22012");
              }
              throw primary;
            },
            (reported) => {
              evidence = reported;
            },
          ),
        );
        expect(actual.error).toBe(primary);
        expect(evidence?.primaryError).toBe(primary);
        expect(evidence?.cleanupFailures).toHaveLength(1);
        expect(evidence?.cleanupFailures[0]?.phase).toBe(mode);
        expect(driverCode(evidence?.cleanupFailures[0]?.error)).toBe(
          mode === "unlock" ? "25P02" : "3B001",
        );
        expect(gateDestroyed).toBe(true);
        expect(gateEnded && workerEnded && drained).toBe(true);
        expect((await pending)?.error).toBeUndefined();
        await waitOwnedBackendsGone(f, [gatePid, workerPid], test.signal);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
              [[gatePid, workerPid]],
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        await rescue();
      }
    },
  );

  async function seed(kind: "receiving" | "transformation") {
    const c = await seedFinalizableTransformation(f);
    if (kind === "receiving")
      return { ...c, originId: c.origin.id, saved: c.saved, command: c.command };
    const upstream = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      c.command,
      "upstream-transformation",
    );
    const output = upstream.snapshot.outputs[0];
    if (!output) throw new Error("Missing upstream output");
    const saved = await c.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.saved.draft,
          inputs: [
            { kind: "ftl_lot", lotId: output.lotId, quantity: "100", unitOfMeasure: "case" },
          ],
          outputs: [
            {
              productId: c.product,
              tlc: "DOWNSTREAM-OUTPUT",
              quantity: "100",
              unitOfMeasure: "case",
            },
          ],
        },
      },
      "downstream-transformation",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    return {
      ...c,
      originId: upstream.id,
      saved,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
    };
  }

  async function connections(own: OwnCleanup) {
    if (!base) throw new Error("Missing isolated database");
    const url = new URL(base);
    url.pathname = "/" + f.databaseName;
    const options = { max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 };
    const acquire = (name: string) => {
      const connection = createDb(url.toString(), options);
      own("pool-end-" + name, () => connection.pool.end());
      return connection;
    };
    return { native: acquire("native"), writer: acquire("writer"), observer: acquire("observer") };
  }

  async function voidOrigin(
    db: typeof f.db,
    c: Awaited<ReturnType<typeof seed>>,
    kind: "receiving" | "transformation",
  ) {
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Owned competing origin void",
    };
    return kind === "receiving"
      ? new UsReceivingStore(db).void(
          c.tenant,
          c.actor,
          c.originId,
          { ...command, commandVersion: 2, expectedDraftVersion: null },
          "public-origin-void",
        )
      : new UsTransformationStore(db).void(
          c.tenant,
          c.actor,
          c.originId,
          command,
          "public-origin-void",
        );
  }

  async function assertOrigin(
    c: Awaited<ReturnType<typeof seed>>,
    kind: "receiving" | "transformation",
    status: "finalized" | "void",
  ) {
    const table = kind === "receiving" ? "receiving_event_roots" : "transformation_event_roots";
    expect(
      (
        await f.pool.query<{ status: string; current_event_id: string | null }>(
          `SELECT e.status,r.current_event_id FROM traceability_events e JOIN ${table} r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id WHERE e.tenant_id=$1 AND e.id=$2`,
          [c.tenant, c.originId],
        )
      ).rows,
    ).toEqual([{ status, current_event_id: status === "finalized" ? c.originId : null }]);
  }

  async function nativeFirst(
    kind: "receiving" | "transformation",
    signal: AbortSignal,
    ready: () => Promise<void>,
    onPids?: (pids: number[]) => void,
  ) {
    const c = await seed(kind);
    signal.throwIfAborted();
    return withOwnedWork(async (own) => {
      const pools = await connections(own);
      const acquired = barrier(),
        release = barrier();
      const workers: {
        finalizing?: ReturnType<typeof outcome>;
        writing?: ReturnType<typeof outcome>;
      } = {};
      own("native-workers-drain", async () => {
        release.release();
        await Promise.all([workers.finalizing, workers.writing]);
      });
      const nativePid = (
        await pools.native.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const writerPid = (
        await pools.writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      if (!nativePid || !writerPid || nativePid === writerPid)
        throw new Error("Missing distinct owned backends");
      const observerPid = (
        await pools.observer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      if (!observerPid) throw new Error("Missing owned observer backend");
      onPids?.([nativePid, writerPid, observerPid]);
      const store = new UsTransformationStore(pools.native.db);
      const finalizing = (workers.finalizing = outcome(
        pools.native.db.transaction(
          async (tx) => {
            const result = await store.finalizeInTransaction(
              tx,
              c.tenant,
              c.actor,
              c.saved.id,
              c.command,
              "native-lock-holder",
            );
            acquired.release();
            await release.promise;
            return result;
          },
          { isolationLevel: "repeatable read" },
        ),
      ));
      await abortable(
        Promise.race([
          acquired.promise,
          finalizing.then(({ error }) => {
            throw error ?? new Error("native_finished_before_locks");
          }),
        ]),
        signal,
      );
      const writing = (workers.writing = outcome(voidOrigin(pools.writer.db, c, kind)));
      await waitBlocked(pools.observer, nativePid, writerPid, signal);
      await abortable(ready(), signal);
      release.release();
      expect((await finalizing).error).toBeUndefined();
      expect((await writing).error).toMatchObject({
        status: 409,
        response: { code: "traceability_downstream_blocked" },
      });
      await assertOrigin(c, kind, "finalized");
      const current = await c.store.getRecord(c.tenant, c.actor, c.saved.id);
      expect(current.status).toBe("finalized");
      expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
        lots: kind === "receiving" ? 1 : 2,
        edges: kind === "receiving" ? 2 : 1,
        bindings: 1,
        receipts: 1,
        audits: 1,
      });
      const before = await f.snapshot();
      expect(
        await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "public-lock-replay"),
      ).toEqual(current);
      expect(await f.snapshot()).toEqual(before);
    });
  }

  async function writerFirst(
    kind: "receiving" | "transformation",
    signal: AbortSignal,
    ready: () => Promise<void>,
  ) {
    const c = await seed(kind);
    signal.throwIfAborted();
    return withOwnedWork(async (own) => {
      const pools = await connections(own);
      const key = Math.floor(Math.random() * 1000000000) + 1;
      const name = "native_origin_gate_" + randomUUID().replaceAll("-", "");
      const workers: {
        finalizing?: ReturnType<typeof outcome>;
        writing?: ReturnType<typeof outcome>;
      } = {};
      own("origin-function-drop", async () => {
        await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
      });
      own("origin-trigger-drop", async () => {
        await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON traceability_events`);
      });
      own("origin-workers-drain", async () => {
        await Promise.all([workers.writing, workers.finalizing]);
      });
      const gate = await connectClient(pools.observer.pool);
      // Client acquisition is inside the owner; destruction releases the session
      // advisory lock even when the unlock SQL itself rejects.
      ownClient(own, gate, "origin-gate-unlock", () =>
        gate.query("SELECT pg_advisory_unlock($1)", [key]),
      );
      const nativePid = (
        await pools.native.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const writerPid = (
        await pools.writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      if (!nativePid || !writerPid || !gatePid) throw new Error("Missing owned backend identities");
      await gate.query("SELECT pg_advisory_lock($1)", [key]);
      await f.pool.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
      );
      await f.pool.query(
        `CREATE TRIGGER ${name} BEFORE UPDATE ON traceability_events FOR EACH ROW WHEN (NEW.tenant_id='${c.tenant}' AND NEW.id='${c.originId}'::uuid AND NEW.status='void') EXECUTE FUNCTION ${name}()`,
      );
      const writing = (workers.writing = outcome(voidOrigin(pools.writer.db, c, kind)));
      // Observe the exact public writer blocked in its owned row trigger after
      // acquiring root/header and affected lot locks, not an assumed call order.
      await waitBlocked({ ...pools.observer, pool: f.pool }, gatePid, writerPid, signal);
      let attempts = 0;
      const finalizing = (workers.finalizing = outcome(
        pools.native.db.transaction(
          (tx) => {
            attempts++;
            return new UsTransformationStore(pools.native.db).finalizeInTransaction(
              tx,
              c.tenant,
              c.actor,
              c.saved.id,
              c.command,
              "native-waiter",
            );
          },
          { isolationLevel: "repeatable read" },
        ),
      ));
      await waitBlocked({ ...pools.observer, pool: f.pool }, writerPid, nativePid, signal);
      await abortable(ready(), signal);
      await gate.query("SELECT pg_advisory_unlock($1)", [key]);
      expect((await writing).error).toBeUndefined();
      // This 40001 is generated naturally by the committed dependency write and
      // stale repeatable-read row lock, unlike the injected SQLSTATE seams tests.
      expect(driverCode((await finalizing).error)).toBe("40001");
      expect(attempts).toBe(1);
      await assertOrigin(c, kind, "void");
      expect(await c.store.getRecord(c.tenant, c.actor, c.saved.id)).toEqual(c.saved);
      expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
        lots: kind === "receiving" ? 0 : 1,
        edges: 0,
        bindings: 0,
        receipts: 0,
        audits: 0,
      });
      const before = await f.snapshot();
      await expect(
        pools.native.db.transaction(
          (tx) =>
            new UsTransformationStore(pools.native.db).finalizeInTransaction(
              tx,
              c.tenant,
              c.actor,
              c.saved.id,
              c.command,
              "native-fresh-origin-check",
            ),
          { isolationLevel: "repeatable read" },
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "event_incomplete" } });
      expect(await f.snapshot()).toEqual(before);
    });
  }

  it.for(["receiving", "transformation"] as const)(
    "holds the actual %s public origin writer behind native finalization",
    { timeout: 15000 },
    async (kind, test) => {
      const observation = startObservation(test, (signal, ready) =>
        nativeFirst(kind, signal, ready),
      );
      try {
        await observation.ready;
        observation.proceed();
        expect((await observation.running).error).toBeUndefined();
      } finally {
        await observation.cleanup();
      }
      expect((await observation.running).error).toBeUndefined();
    },
  );

  it.for(["receiving", "transformation"] as const)(
    "waits behind the actual %s origin writer and rejects its now absent origin without output",
    { timeout: 15000 },
    async (kind, test) => {
      const observation = startObservation(test, (signal, ready) =>
        writerFirst(kind, signal, ready),
      );
      try {
        await observation.ready;
        observation.proceed();
        expect((await observation.running).error).toBeUndefined();
      } finally {
        await observation.cleanup();
      }
      expect((await observation.running).error).toBeUndefined();
    },
  );

  it("cancels an observed native holder and drains every actual blocked connection before fixture disposal", async (test) => {
    let ownedPids: number[] = [];
    const observation = startObservation(test, (signal, ready) =>
      nativeFirst("receiving", signal, ready, (pids) => {
        ownedPids = pids;
      }),
    );
    try {
      await observation.ready;
      observation.abort.abort(new Error("injected_observation_cancel"));
      expect((await observation.running).error).toMatchObject({
        message: "injected_observation_cancel",
      });
      await observation.cleanup();
      expect(ownedPids).toHaveLength(3);
      await waitOwnedBackendsGone(f, ownedPids, test.signal);
      expect(
        (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
            [ownedPids],
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      await observation.cleanup();
    }
  }, 15000);

  it.for(["failure", "cancellation"] as const)(
    "settles %s before readiness and drains its owned transaction",
    async (mode, test) => {
      const injected = new AbortController();
      const entered = barrier(),
        setup = barrier();
      const failure = new Error("before_readiness_" + mode);
      let registered = false,
        drained = false,
        pid = 0;
      const observation = startObservation(
        {
          signal: AbortSignal.any([test.signal, injected.signal]),
          onTestFinished: (cleanup) => {
            registered = true;
            test.onTestFinished(cleanup);
          },
        },
        async (signal) => {
          return withOwnedWork(async (own) => {
            expect(registered).toBe(true);
            const client = await connectClient(f.pool);
            ownClient(
              own,
              client,
              "pre-readiness-rollback",
              () => client.query("ROLLBACK"),
              () => {
                client.release(true);
                drained = true;
              },
            );
            await client.query("BEGIN");
            pid =
              (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                ?.pid ?? 0;
            entered.release();
            if (mode === "failure") throw failure;
            await abortable(setup.promise, signal);
          });
        },
      );
      let settled = false;
      const readiness = outcome(observation.ready).then((value) => {
        settled = true;
        return value;
      });
      try {
        await abortable(entered.promise, test.signal);
        if (mode === "cancellation") injected.abort(failure);
        await expect.poll(() => settled, { timeout: 500 }).toBe(true);
        expect((await readiness).error).toBe(failure);
        expect((await observation.running).error).toBe(failure);
        await observation.cleanup();
        expect(drained).toBe(true);
        expect(pid).toBeGreaterThan(0);
        await waitOwnedBackendsGone(f, [pid], test.signal);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
              [pid],
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        setup.release();
        await observation.cleanup();
        await readiness;
      }
    },
  );
});
