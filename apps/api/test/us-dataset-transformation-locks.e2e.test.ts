import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  composeDatasetTransformation,
  datasetTransformationStores,
} from "./support/us-dataset-transformation-fixture";
import { lockUsDatasetTransformation } from "../src/modules/traceability/demo/us-dataset-transformation-locks";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { verifyUsDatasetTransformation } from "../src/modules/traceability/demo/us-dataset-transformation-verify";
import {
  barrier,
  outcome,
  abortable,
  startObservation,
  waitBlocked,
  withOwnedWork,
  ownClient,
  type OwnCleanup,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Transformation joint locks", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it("accepts receipt-owned roots and lots without mutations", async () => {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    const before = await f.snapshot();
    await f.db.transaction((tx) =>
      lockUsDatasetTransformation(tx, context, {
        receiving: c.receiving,
        transformation: c.result,
      }),
    );
    expect(await f.snapshot()).toEqual(before);
  }, 30000);

  it.for(["missing", "wrong-type", "foreign"] as const)(
    "rejects %s receipt-owned roots without mutations",
    async (kind) => {
      const context = await f.provision(),
        c = await composeDatasetTransformation(f.db, context);
      const target =
        kind === "foreign"
          ? c.result
          : parseUsDatasetTransformationResult(
              JSON.parse(
                JSON.stringify(c.result).replaceAll(
                  c.result.created.id,
                  kind === "wrong-type" ? c.receiving.created.eventId : randomUUID(),
                ),
              ),
            );
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          lockUsDatasetTransformation(
            tx,
            kind === "foreign" ? { ...context, tenantId: randomUUID() } : context,
            { receiving: c.receiving, transformation: target },
          ),
        ),
      ).rejects.toThrow("us_dataset_transformation_mismatch");
      expect(await f.snapshot()).toEqual(before);
    },
  );

  // Actual public writer map (all compared rows remain locked until commit):
  // Receiving amend/finalize/void -> receiving root + revision -> affected lots;
  // Transformation amend/save/finalize/void -> transformation root + revisions -> sorted lots;
  // lot status/source and downstream consumers -> lot UPDATE lock; permanent source is denied;
  // party -> party UPDATE; location -> parent SHARE then location UPDATE;
  // catalog product/profile -> product UPDATE (profile serialized by parent product);
  // reference documents have create-only public API; UPDATE below is explicit corruption;
  // origin/output/genealogy insertions are private native finalization, later lifecycle
  // holds its root and affected lots. Operations and audits have no mutation API.
  type Kind =
    | "void"
    | "amend"
    | "receiving amendment"
    | "lot"
    | "party"
    | "location"
    | "product"
    | "profile"
    | "document";
  type Composition = Awaited<ReturnType<typeof composeDatasetTransformation>>;
  type Context = Awaited<ReturnType<typeof f.provision>>;
  function connections(own: OwnCleanup) {
    if (!base) throw new Error("Missing isolated database");
    const url = new URL(base);
    url.pathname = "/" + f.databaseName;
    const acquire = (name: string) => {
      const connection = createDb(url.toString(), {
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 8000,
      });
      own("pool-end-" + name, () => connection.pool.end());
      return connection;
    };
    return { replay: acquire("replay"), writer: acquire("writer"), gate: acquire("gate") };
  }
  async function pid(connection: ReturnType<typeof createDb>) {
    const value = (await connection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    if (!value) throw new Error("Missing owned backend PID");
    return value;
  }
  async function write(
    connection: ReturnType<typeof createDb>,
    context: Context,
    c: Composition,
    kind: Kind,
  ) {
    const stores = datasetTransformationStores(connection.db);
    const args = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Synthetic competing writer",
    };
    const { tenantId, actorUserId } = context;
    if (kind === "void" || kind === "amend")
      return stores.transformation[kind](
        tenantId,
        actorUserId,
        c.result.created.id,
        args,
        "competing-lifecycle",
      );
    if (kind === "receiving amendment")
      return stores.receiving.amend(
        tenantId,
        actorUserId,
        c.receiving.created.eventId,
        { ...args, commandVersion: 2 },
        "competing-receiving",
      );
    if (kind === "lot")
      return stores.lots.changeStatus(
        tenantId,
        actorUserId,
        c.result.outputLot.id,
        { status: "archived", expectedRevision: 1, reason: args.reason },
        "competing-lot",
      );
    if (kind === "party")
      return stores.master.updateParty(
        tenantId,
        actorUserId,
        c.references.bindings.parties[0]?.id,
        { name: "Synthetic changed" },
        "competing-party",
      );
    if (kind === "location")
      return stores.master.updateLocation(
        tenantId,
        actorUserId,
        c.references.bindings.locations[0]?.id,
        { businessName: "Synthetic changed" },
        "competing-location",
      );
    if (kind === "product")
      return stores.catalog.updateProduct(
        tenantId,
        actorUserId,
        c.result.outputLot.productId,
        { name: "Synthetic changed" },
        "competing-product",
      );
    if (kind === "profile") {
      const profile = c.references.evidence.profiles[0];
      if (!profile) throw new Error("Missing profile");
      const { productId, revision, reviewedBy, reviewedAt, createdAt, updatedAt, ...editable } =
        profile;
      void [reviewedBy, reviewedAt, createdAt, updatedAt];
      return stores.profiles.putProfile(
        tenantId,
        actorUserId,
        productId,
        { ...editable, productName: "Synthetic changed", expectedRevision: revision },
        "competing-profile",
      );
    }
    return connection.pool.query(
      "UPDATE reference_documents SET notes='Synthetic corruption' WHERE tenant_id=$1 AND id=$2",
      [tenantId, c.result.documents[0]?.record.id],
    );
  }

  async function schedule(
    kind: Kind,
    order: "replay first" | "writer first",
    signal: AbortSignal,
    ready: () => Promise<void>,
    reportPids?: (pids: number[]) => void,
  ) {
    const context = await f.provision();
    const c = await composeDatasetTransformation(f.db, context);
    signal.throwIfAborted();
    return withOwnedWork(async (own) => {
      const pools = connections(own);
      const replayPid = await pid(pools.replay),
        writerPid = await pid(pools.writer),
        gatePid = await pid(pools.gate);
      reportPids?.([replayPid, writerPid, gatePid]);
      const acquired = barrier(),
        release = barrier();
      const workers: { replay?: ReturnType<typeof outcome>; writer?: ReturnType<typeof outcome> } =
        {};
      const replay = () =>
        pools.replay.db.transaction(async (tx) => {
          await verifyUsDatasetTransformation(
            tx,
            context,
            c.intent,
            c.receipt,
            datasetTransformationStores(pools.replay.db),
            "replay",
          );
          acquired.release();
          if (order === "replay first") await release.promise;
        });
      if (order === "replay first") {
        own("release-before-drain", async () => {
          release.release();
          await Promise.all([workers.replay, workers.writer]);
        });
        workers.replay = outcome(replay());
        await abortable(
          Promise.race([
            acquired.promise,
            workers.replay.then(({ error }) => {
              throw error ?? new Error("Replay finished before barrier");
            }),
          ]),
          signal,
        );
        workers.writer = outcome(write(pools.writer, context, c, kind));
        await waitBlocked({ ...pools.gate, pool: f.pool }, replayPid, writerPid, signal);
        await abortable(ready(), signal);
        release.release();
        expect((await workers.replay).error).toBeUndefined();
        expect((await workers.writer).error).toBeUndefined();
      } else {
        const lifecycle = kind === "void" || kind === "amend" || kind === "receiving amendment";
        if (lifecycle) {
          own("lifecycle-workers-drain", async () => {
            await Promise.all([workers.writer, workers.replay]);
          });
          const gate = await pools.gate.pool.connect();
          ownClient(own, gate, "header-gate-rollback", () => gate.query("ROLLBACK"));
          await gate.query("BEGIN");
          const eventId =
            kind === "receiving amendment" ? c.receiving.created.eventId : c.result.created.id;
          await gate.query(
            "SELECT id FROM traceability_events WHERE tenant_id=$1 AND id=$2 FOR SHARE",
            [context.tenantId, eventId],
          );
          workers.writer = outcome(write(pools.writer, context, c, kind));
          // Public readTransformationRecord has acquired root UPDATE and now waits
          // for header UPDATE, BEFORE lockTransformationLots. This catches inversion.
          await waitBlocked({ ...pools.gate, pool: f.pool }, gatePid, writerPid, signal);
          workers.replay = outcome(replay());
          await waitBlocked({ ...pools.gate, pool: f.pool }, writerPid, replayPid, signal);
          // Independent NOWAIT acquisition proves replay did not lock inbound lots
          // while waiting for Transformation root. A receiving-first verifier fails here.
          await withOwnedWork(async (ownProbe) => {
            const probe = await f.pool.connect();
            ownClient(ownProbe, probe, "probe-rollback", () => probe.query("ROLLBACK"));
            await probe.query("BEGIN");
            const lots = await probe.query(
              "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
              [context.tenantId, c.receiving.lots.map((lot) => lot.id)],
            );
            expect(lots.rowCount).toBe(2);
          });
          await abortable(ready(), signal);
          await gate.query("ROLLBACK");
        } else {
          const [table, rowId] =
            kind === "lot"
              ? ["traceability_lots", c.result.outputLot.id]
              : kind === "party"
                ? ["traceability_parties", c.references.bindings.parties[0]?.id]
                : kind === "location"
                  ? ["traceability_locations", c.references.bindings.locations[0]?.id]
                  : kind === "product"
                    ? ["products", c.result.outputLot.productId]
                    : kind === "profile"
                      ? [
                          "product_traceability_profiles",
                          c.references.evidence.profiles[0]?.productId,
                        ]
                      : ["reference_documents", c.result.documents[0]?.record.id];
          const name = "dataset_gate_" + randomUUID().replaceAll("-", "");
          const key = Math.floor(Math.random() * 1000000000) + 1;
          own("function-drop", async () => {
            await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
          });
          own("trigger-drop", async () => {
            await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
          });
          own("workers-drain", async () => {
            await Promise.all([workers.writer, workers.replay]);
          });
          const gate = await pools.gate.pool.connect();
          ownClient(own, gate, "writer-gate-unlock", () =>
            gate.query("SELECT pg_advisory_unlock($1)", [key]),
          );
          await gate.query("SELECT pg_advisory_lock($1)", [key]);
          await f.pool.query(
            `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`,
          );
          await f.pool.query(
            `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW WHEN (NEW.tenant_id='${context.tenantId}' AND NEW.${kind === "profile" ? "product_id" : "id"}='${rowId}'::uuid) EXECUTE FUNCTION ${name}()`,
          );
          workers.writer = outcome(write(pools.writer, context, c, kind));
          await waitBlocked({ ...pools.gate, pool: f.pool }, gatePid, writerPid, signal);
          workers.replay = outcome(replay());
          await waitBlocked({ ...pools.gate, pool: f.pool }, writerPid, replayPid, signal);
          await abortable(ready(), signal);
          await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        }
        expect((await workers.writer).error).toBeUndefined();
        expect((await workers.replay).error).toMatchObject({
          message: "us_dataset_transformation_mismatch",
        });
      }
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          verifyUsDatasetTransformation(tx, context, c.intent, c.receipt, c.stores, "replay"),
        ),
      ).rejects.toThrow("us_dataset_transformation_mismatch");
      expect(await f.snapshot()).toEqual(before);
    });
  }

  for (const order of ["replay first", "writer first"] as const) {
    it.for([
      "void",
      "amend",
      "receiving amendment",
      "lot",
      "party",
      "location",
      "product",
      "profile",
      "document",
    ] as const)(
      `${order}: observes actual %s blocker PID and stable post-release verification`,
      { timeout: 20000 },
      async (kind, test) => {
        const observation = startObservation(test, (signal, ready) =>
          schedule(kind, order, signal, ready),
        );
        try {
          await observation.ready;
          observation.proceed();
          expect((await observation.running).error).toBeUndefined();
        } finally {
          await observation.cleanup();
        }
      },
    );
  }

  it("source correction waits behind replay then preserves permanent output source lock", async (test) => {
    const context = await f.provision(),
      c = await composeDatasetTransformation(f.db, context);
    const observation = startObservation(test, async (signal, ready) =>
      withOwnedWork(async (own) => {
        const pools = connections(own),
          acquired = barrier(),
          release = barrier();
        const workers: {
          replaying?: ReturnType<typeof outcome>;
          writing?: ReturnType<typeof outcome>;
        } = {};
        own("release-before-drain", async () => {
          release.release();
          await Promise.all([workers.replaying, workers.writing]);
        });
        const replayPid = await pid(pools.replay),
          writerPid = await pid(pools.writer);
        const replaying = (workers.replaying = outcome(
          pools.replay.db.transaction(async (tx) => {
            await verifyUsDatasetTransformation(
              tx,
              context,
              c.intent,
              c.receipt,
              datasetTransformationStores(pools.replay.db),
              "replay",
            );
            acquired.release();
            await release.promise;
          }),
        ));
        await abortable(
          Promise.race([
            acquired.promise,
            replaying.then(({ error }) => {
              throw error;
            }),
          ]),
          signal,
        );
        const writing = (workers.writing = outcome(
          datasetTransformationStores(pools.writer.db).lots.changeSource(
            context.tenantId,
            context.actorUserId,
            c.result.outputLot.id,
            {
              expectedRevision: 1,
              source: c.result.outputLot.source,
              reason: "Synthetic correction",
            },
            "source-correction",
          ),
        ));
        await waitBlocked(pools.gate, replayPid, writerPid, signal);
        await abortable(ready(), signal);
        release.release();
        expect((await writing).error).toMatchObject({ response: { code: "lot_source_locked" } });
        expect((await replaying).error).toBeUndefined();
      }),
    );
    try {
      await observation.ready;
      observation.proceed();
      expect((await observation.running).error).toBeUndefined();
    } finally {
      await observation.cleanup();
    }
  }, 15000);

  it.for(["replay first", "writer first"] as const)(
    "cancels while actually blocked (%s) and drains every acquired backend",
    { timeout: 20000 },
    async (order, test) => {
      const failure = new Error("owned_dataset_cancellation"),
        aborted = new AbortController();
      let pids: number[] = [];
      const observation = startObservation(
        {
          signal: AbortSignal.any([test.signal, aborted.signal]),
          onTestFinished: test.onTestFinished,
        },
        (signal, ready) =>
          schedule("void", order, signal, ready, (owned) => {
            pids = owned;
          }),
      );
      try {
        await observation.ready;
        aborted.abort(failure);
        expect((await observation.running).error).toBe(failure);
        await observation.cleanup();
        expect(pids).toHaveLength(3);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
              [pids],
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        await observation.cleanup();
      }
    },
  );

  it.for(["failure", "cancellation"] as const)(
    "preserves %s before readiness and rolls back its real transaction",
    async (kind, test) => {
      const failure = new Error("owned_pre_barrier_" + kind),
        injected = new AbortController(),
        entered = barrier(),
        setup = barrier();
      let workerPid = 0,
        drained = false;
      const observation = startObservation(
        {
          signal: AbortSignal.any([test.signal, injected.signal]),
          onTestFinished: test.onTestFinished,
        },
        (signal) =>
          withOwnedWork(async (own) => {
            const client = await f.pool.connect();
            ownClient(
              own,
              client,
              "pre-barrier-rollback",
              () => client.query("ROLLBACK"),
              () => {
                client.release(true);
                drained = true;
              },
            );
            await client.query("BEGIN");
            workerPid =
              (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                ?.pid ?? 0;
            entered.release();
            if (kind === "failure") throw failure;
            await abortable(setup.promise, signal);
          }),
      );
      const readiness = outcome(observation.ready);
      try {
        await abortable(entered.promise, test.signal);
        if (kind === "cancellation") injected.abort(failure);
        expect((await readiness).error).toBe(failure);
        expect((await observation.running).error).toBe(failure);
        await observation.cleanup();
        expect(drained).toBe(true);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
              [workerPid],
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

  const timedOut: {
    phase: string;
    aborted: boolean;
    sameReason: boolean;
    observed: boolean;
    absent: boolean;
  }[] = [];
  // These expected failures intentionally exercise Vitest's OWN TestContext.signal,
  // not just a stand-in AbortController. The following ordinary test proves the
  // exact timeout path and independent cleanup; an unrelated failure cannot pass it.
  it.fails(
    "runner timeout aborts actual TestContext.signal before readiness",
    { timeout: 400 },
    async (test) => {
      let workerPid = 0;
      const observation = startObservation(test, (signal) =>
        withOwnedWork(async (own) => {
          const client = await f.pool.connect();
          ownClient(own, client, "actual-timeout-rollback", () => client.query("ROLLBACK"));
          await client.query("BEGIN");
          workerPid =
            (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ??
            0;
          await abortable(barrier().promise, signal);
        }),
      );
      const readiness = outcome(observation.ready);
      test.onTestFinished(async () => {
        await observation.cleanup();
        const completed = await observation.running;
        await readiness;
        const count = (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
            [workerPid],
          )
        ).rows[0]?.n;
        timedOut.push({
          phase: "before readiness",
          aborted: test.signal.aborted,
          sameReason: completed.error === test.signal.reason,
          observed: workerPid > 0,
          absent: count === 0,
        });
      });
      await observation.ready;
    },
  );
  it.fails(
    "runner timeout aborts actual TestContext.signal during observed root contention",
    { timeout: 5000 },
    async (test) => {
      let observed = false,
        pids: number[] = [];
      const observation = startObservation(test, (signal, ready) =>
        schedule("void", "writer first", signal, ready, (owned) => {
          pids = owned;
        }),
      );
      test.onTestFinished(async () => {
        await observation.cleanup();
        const completed = await observation.running;
        const count = (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
            [pids],
          )
        ).rows[0]?.n;
        timedOut.push({
          phase: "while blocked",
          aborted: test.signal.aborted,
          sameReason: completed.error === test.signal.reason,
          observed: observed && pids.length === 3,
          absent: count === 0,
        });
      });
      await observation.ready;
      observed = true;
      const result = await observation.running;
      if (result.error) throw result.error;
    },
  );
  it("proves both actual runner timeouts reached their intended barrier and disposed every backend", () => {
    expect(timedOut).toEqual([
      { phase: "before readiness", aborted: true, sameReason: true, observed: true, absent: true },
      { phase: "while blocked", aborted: true, sameReason: true, observed: true, absent: true },
    ]);
  });
});
