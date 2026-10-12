import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
import { describe, expect, it, type TestContext } from "vitest";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { verifyUsDatasetCorrectedTransformation } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-verify";
import { specialFixture } from "./support/us-dataset-special-fixture";
import {
  prepareDatasetCorrectedTransformation,
  datasetCorrectedTransformationStores,
} from "./support/us-dataset-corrected-transformation-fixture";
import {
  abortable,
  barrier,
  outcome,
  waitBlocked,
  startObservation,
  withOwnedWork,
  ownClient,
  type OwnCleanup,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Corrected Transformation native lifecycle locks", () => {
  const h = specialFixture(base);
  async function prepare() {
    const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
    const result = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(
      h.context,
    );
    const stage = await c.stores.journal.readStage(
      h.context,
      c.header.id,
      "correction_0001",
      "transformation",
    );
    if (!stage?.receipt) throw new Error("Missing corrected receipt");
    return { ...c, result, stage };
  }
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  type Kind = "Receiving amend" | "Receiving void" | "Transformation amend" | "Transformation void";
  function connections(own: OwnCleanup) {
    if (!base) throw new Error("Missing isolated base");
    const url = new URL(base);
    url.pathname = "/" + h.f.databaseName;
    const acquire = (name: string) => {
      const c = createDb(url.toString(), {
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 8000,
      });
      own(name, () => c.pool.end());
      return c;
    };
    return {
      replay: acquire("replay-pool"),
      writer: acquire("writer-pool"),
      gate: acquire("gate-pool"),
    };
  }
  async function pid(c: ReturnType<typeof createDb>) {
    const id = (await c.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]?.pid;
    if (!id) throw new Error("Missing owned PID");
    return id;
  }
  function write(c: ReturnType<typeof createDb>, prepared: Prepared, kind: Kind) {
    const stores = datasetCorrectedTransformationStores(c.db);
    const args = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: kind.startsWith("Receiving") ? 4 : 2,
      reason: "Synthetic competing native lifecycle",
    };
    if (kind === "Receiving amend" || kind === "Receiving void")
      return stores.receiving[kind === "Receiving amend" ? "amend" : "void"](
        h.context.tenantId,
        h.context.actorUserId,
        prepared.lifecycle.finalized.eventId,
        {
          ...args,
          commandVersion: 2,
          ...(kind === "Receiving void" ? { expectedDraftVersion: null } : {}),
        },
        randomUUID(),
      );
    return stores.transformation[kind === "Transformation amend" ? "amend" : "void"](
      h.context.tenantId,
      h.context.actorUserId,
      prepared.result.created.id,
      args,
      randomUUID(),
    );
  }
  async function schedule(
    kind: Kind,
    order: "replay first" | "writer first",
    signal: AbortSignal,
    ready: () => Promise<void>,
  ) {
    const prepared = await prepare();
    await withOwnedWork(async (own) => {
      const c = connections(own);
      const replayPid = await pid(c.replay),
        writerPid = await pid(c.writer),
        gatePid = await pid(c.gate);
      const held = barrier(),
        release = barrier();
      const workers: { replay?: ReturnType<typeof outcome>; writer?: ReturnType<typeof outcome> } =
        {};
      // Registered before worker continuations; independent gate release precedes draining.
      own("worker-drain", async () => {
        await Promise.allSettled([workers.replay, workers.writer]);
      });
      own("release-replay", async () => {
        release.release();
      });
      const replay = () => {
        const stores = datasetCorrectedTransformationStores(c.replay.db);
        return stores.journal.runAtomicStage(
          h.context,
          prepared.header.id,
          prepared.stage.revision,
          prepared.stage.intent,
          {
            apply: async () => {
              throw new Error("Unexpected corrected replay apply");
            },
            verify: async (tx, context, intent, receipt) => {
              await verifyUsDatasetCorrectedTransformation(
                tx,
                context,
                intent,
                receipt,
                stores,
                "replay",
              );
              held.release();
              if (order === "replay first") await release.promise;
            },
          },
        );
      };
      if (order === "replay first") {
        workers.replay = outcome(replay());
        await abortable(
          Promise.race([
            held.promise,
            workers.replay.then(({ error }) => {
              throw error ?? new Error("Replay ended before gate");
            }),
          ]),
          signal,
        );
        workers.writer = outcome<unknown>(write(c.writer, prepared, kind));
        await waitBlocked({ ...c.gate, pool: h.f.pool }, replayPid, writerPid, signal);
        await abortable(ready(), signal);
        release.release();
        expect((await workers.replay).error).toBeUndefined();
      } else {
        const gate = await c.gate.pool.connect();
        ownClient(own, gate, "header-gate-release", () => gate.query("ROLLBACK"));
        await gate.query("BEGIN");
        const eventId = kind.startsWith("Receiving")
          ? prepared.lifecycle.finalized.eventId
          : prepared.result.created.id;
        await gate.query(
          "SELECT id FROM traceability_events WHERE tenant_id=$1 AND id=$2 FOR SHARE",
          [h.context.tenantId, eventId],
        );
        workers.writer = outcome<unknown>(write(c.writer, prepared, kind));
        await waitBlocked({ ...c.gate, pool: h.f.pool }, gatePid, writerPid, signal);
        workers.replay = outcome(replay());
        await waitBlocked({ ...c.gate, pool: h.f.pool }, writerPid, replayPid, signal);
        // Public writer holds its root and waits on the revision. Replay must hold no input lot yet.
        await withOwnedWork(async (ownProbe) => {
          const probe = await h.f.pool.connect();
          ownClient(ownProbe, probe, "inversion-probe-rollback", () => probe.query("ROLLBACK"));
          await probe.query("BEGIN");
          if (kind.startsWith("Transformation")) {
            await probe.query("SAVEPOINT receiving_root_probe");
            await expect(
              probe.query(
                "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
                [h.context.tenantId, prepared.original.created.eventId],
              ),
            ).rejects.toMatchObject({ code: "55P03" });
            await probe.query("ROLLBACK TO SAVEPOINT receiving_root_probe");
          }
          expect(
            (
              await probe.query(
                "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
                [
                  h.context.tenantId,
                  prepared.input.receivingOrigin.inputLots.map(({ lotId }) => lotId),
                ],
              )
            ).rowCount,
          ).toBe(2);
        });
        await abortable(ready(), signal);
        await gate.query("ROLLBACK");
        if (kind === "Receiving void") expect((await workers.replay).error).toBeUndefined();
        else
          expect((await workers.replay).error).toMatchObject({
            message: "us_dataset_corrected_transformation_mismatch",
          });
      }
      const written = await workers.writer;
      if (kind === "Receiving void")
        expect(written?.error).toMatchObject({
          response: { code: "traceability_downstream_blocked" },
        });
      else expect(written?.error).toBeUndefined();
      const before = await h.f.snapshot();
      const seed = new UsDatasetCorrectedTransformationSeedStore(h.f.db);
      if (kind === "Receiving void") expect(await seed.verify(h.context)).toEqual(prepared.result);
      else
        await expect(seed.verify(h.context)).rejects.toThrow(
          "us_dataset_corrected_transformation_mismatch",
        );
      expect(await h.f.snapshot()).toEqual(before);
      const root = kind.startsWith("Receiving")
        ? "receiving_event_roots"
        : "transformation_event_roots";
      const id = kind.startsWith("Receiving")
        ? prepared.original.created.eventId
        : prepared.result.created.id;
      const current = (
        await h.f.pool.query(
          "SELECT current_event_id,pending_draft_id,lifecycle_version FROM " +
            root +
            " WHERE id=$1",
          [id],
        )
      ).rows[0];
      expect(current?.lifecycle_version).toBe(
        kind === "Receiving amend" ? 5 : kind === "Receiving void" ? 4 : 3,
      );
      if (kind.endsWith("amend")) expect(current?.pending_draft_id).not.toBeNull();
      if (kind === "Transformation void") expect(current?.current_event_id).toBeNull();
    });
  }
  for (const order of ["replay first", "writer first"] as const) {
    it.for([
      "Receiving amend",
      "Receiving void",
      "Transformation amend",
      "Transformation void",
    ] as const)(
      `${order}: PID-observed %s preserves root-before-lot lifecycle ordering`,
      { timeout: 20_000 },
      h.phase(async (kind, test) => {
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
      }),
    );
  }
  it.for(["transformation.create", "transformation.finalize"] as const)(
    "arbitrates %s before acquiring the Receiving root",
    { timeout: 20_000 },
    h.phase(async (command, test) => {
      const prepared = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      await prepared.stores.journal.captureIntent(h.context, prepared.header.id, prepared.intent);
      const observation = startObservation(test, (signal, ready) =>
        withOwnedWork(async (own) => {
          const c = connections(own);
          const workerPid = await pid(c.replay),
            gatePid = await pid(c.gate);
          const worker: { running?: ReturnType<typeof outcome> } = {};
          own("arbitration-worker-drain", async () => {
            await worker.running;
          });
          const gate = await c.gate.pool.connect();
          const key = JSON.stringify([
            "us-transformation",
            h.context.tenantId,
            command,
            prepared.intent.operationKey,
          ]);
          ownClient(own, gate, "operation-gate-release", () =>
            gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]),
          );
          await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
          worker.running = outcome(
            new UsDatasetCorrectedTransformationSeedStore(c.replay.db).initialize(h.context),
          );
          await waitBlocked({ ...c.gate, pool: h.f.pool }, gatePid, workerPid, signal);
          await withOwnedWork(async (ownProbe) => {
            const probe = await h.f.pool.connect();
            ownClient(ownProbe, probe, "operation-root-probe", () => probe.query("ROLLBACK"));
            await probe.query("BEGIN");
            expect(
              (
                await probe.query(
                  "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
                  [h.context.tenantId, prepared.original.created.eventId],
                )
              ).rowCount,
            ).toBe(1);
          });
          await abortable(ready(), signal);
          await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
          expect((await worker.running).error).toBeUndefined();
        }),
      );
      try {
        await observation.ready;
        observation.proceed();
        expect((await observation.running).error).toBeUndefined();
      } finally {
        await observation.cleanup();
      }
    }),
  );
  it(
    "releases actual lifecycle gates before draining a deliberately cancelled lock schedule",
    { timeout: 20_000 },
    h.phase(async (test: TestContext) => {
      const cancelled = new AbortController(),
        failure = new Error("Synthetic corrected observed cancellation");
      const observation = startObservation(
        {
          signal: AbortSignal.any([test.signal, cancelled.signal]),
          onTestFinished: test.onTestFinished,
        },
        (signal, ready) => schedule("Transformation amend", "writer first", signal, ready),
      );
      try {
        await observation.ready;
        cancelled.abort(failure);
        expect((await observation.running).error).toBe(failure);
      } finally {
        await observation.cleanup();
      }
      expect(
        (
          await h.f.pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    }),
  );
  it(
    "public Receiving start remains permitted but subsequent finalization and void are downstream-blocked",
    h.phase(async () => {
      const c = await prepare();
      const voidBefore = await h.f.snapshot();
      await expect(
        c.stores.receiving.void(
          h.context.tenantId,
          h.context.actorUserId,
          c.lifecycle.finalized.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: 4,
            expectedDraftVersion: null,
            reason: "Synthetic downstream void",
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ response: { code: "traceability_downstream_blocked" } });
      expect(await h.f.snapshot()).toEqual(voidBefore);
      const started = await c.stores.receiving.amend(
        h.context.tenantId,
        h.context.actorUserId,
        c.lifecycle.finalized.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 4,
          reason: "Synthetic downstream amendment",
        },
        randomUUID(),
      );
      expect(started.record.lifecycle.lifecycleVersion).toBe(5);
      if (started.record.content.kind !== "draft")
        throw new Error("Missing pending native amendment");
      const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
      const first = draft.items[0];
      if (!first) throw new Error("Missing retained first line");
      first.quantity = "350";
      const saved = await c.stores.receiving.saveAmendment(
        h.context.tenantId,
        h.context.actorUserId,
        started.eventId,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 5,
          expectedDraftVersion: started.record.draftVersion,
          draft,
        },
        randomUUID(),
      );
      const ready = await c.stores.receiving.checkRevisionReadiness(
        h.context.tenantId,
        h.context.actorUserId,
        saved.eventId,
        { expectedDraftVersion: saved.record.draftVersion },
      );
      const before = await h.f.snapshot();
      await expect(
        c.stores.receiving.finalizeRevision(
          h.context.tenantId,
          h.context.actorUserId,
          started.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedDraftVersion: ready.draftVersion,
            expectedInputDigest: ready.inputDigest,
            expectedLifecycleVersion: ready.expectedLifecycleVersion,
            previousRevisionId: ready.previousRevisionId,
            reviewedExemptLines: [],
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ response: { code: "traceability_downstream_blocked" } });
      expect(await h.f.snapshot()).toEqual(before);
      await expect(
        new UsDatasetCorrectedTransformationSeedStore(h.f.db).verify(h.context),
      ).rejects.toThrow("us_dataset_corrected_transformation_mismatch");
    }),
  );
});
