import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  prepareDatasetShippingFixture,
  type UsDatasetJournalFixture,
} from "./support/us-dataset-shipping-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { verifyUsDatasetShipping } from "../src/modules/traceability/demo/us-dataset-shipping-verify";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { parseUsDatasetCasesResult } from "../src/modules/traceability/demo/us-dataset-cases-contract";
import { parseUsDatasetReceivingResult } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  abortable,
  barrier,
  outcome,
  startObservation,
  waitBlocked,
  withOwnedWork,
  ownClient,
  driverCode,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Shipping read-committed writer locks", () => {
  let f: UsDatasetJournalFixture;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US URL");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  type Kind =
    | "amend"
    | "void"
    | "pending void"
    | "status"
    | "source"
    | "unlink"
    | "consume"
    | "same-key finalize"
    | "same-key case";
  async function schedule(
    kind: Kind,
    order: "verifier first" | "writer first",
    signal: AbortSignal,
    ready: () => Promise<void>,
    reportPids: (pids: number[]) => void = () => {},
  ) {
    const context = await f.provision(),
      prepared = await prepareDatasetShippingFixture(f, context, 0);
    const result = await new UsDatasetShippingSeedStore(f.db).initialize(context, 0);
    const last = result.shipments.at(-1),
      stage = await datasetTransformationStores(f.db).journal.readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "shipping",
      );
    if (!last || !stage?.receipt) throw new Error("Missing owned receipt");
    let pendingId: string | undefined, consume: { id: string; digest: string } | undefined;
    const shipping = new UsShippingStore(f.db);
    if (kind === "pending void")
      pendingId = (
        await shipping.amend(
          context.tenantId,
          context.actorUserId,
          last.created.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Synthetic pending amendment",
          },
          "prepare-pending",
        )
      ).eventId;
    if (kind === "consume") {
      const draft = await shipping.createDraft(
        context.tenantId,
        context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            ...last.createInput.draft,
            items: [{ lotId: result.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
          },
        },
        "prepare-consumer",
      );
      const checked = await shipping.checkReadiness(
        context.tenantId,
        context.actorUserId,
        draft.id,
        { expectedDraftVersion: 1 },
      );
      consume = { id: draft.id, digest: checked.inputDigest };
    }
    await withOwnedWork(async (own) => {
      if (!base) throw new Error("Missing isolated US URL");
      const url = new URL(base);
      url.pathname = "/" + f.databaseName;
      const take = (name: string) => {
        const c = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
        own("pool " + name, () => c.pool.end());
        return c;
      };
      const reader = take("reader"),
        writer = take("writer"),
        gatePool = take("gate");
      const pid = async (c: ReturnType<typeof createDb>) => {
        const id = (await c.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        if (!id) throw new Error("Missing owned PID");
        return id;
      };
      const readerPid = await pid(reader),
        writerPid = await pid(writer),
        gatePid = await pid(gatePool);
      reportPids([readerPid, writerPid, gatePid]);
      expect(new Set([readerPid, writerPid, gatePid]).size).toBe(3);
      const acquired = barrier(),
        release = barrier();
      const workers: { reader?: ReturnType<typeof outcome>; writer?: ReturnType<typeof outcome> } =
        {};
      own("release barriers before actual worker drain", async () => {
        release.release();
        await Promise.all([workers.reader, workers.writer]);
      });
      const read = () =>
        reader.db.transaction(
          async (tx) => {
            const checked = await outcome(
              verifyUsDatasetShipping(
                tx,
                context,
                stage.intent,
                stage.receipt ??
                  (() => {
                    throw new Error("Missing receipt");
                  })(),
                {
                  ...datasetTransformationStores(reader.db),
                  shipping: new UsShippingStore(reader.db),
                },
                "replay",
              ),
            );
            if (order === "verifier first" && kind !== "pending void" && checked.error)
              throw checked.error;
            if (order === "writer first" || kind === "pending void")
              expect(checked.error).toBeDefined();
            acquired.release();
            if (order === "verifier first") await release.promise;
          },
          { isolationLevel: "read committed" },
        );
      const write = async (): Promise<unknown> => {
        const stores = datasetTransformationStores(writer.db),
          native = new UsShippingStore(writer.db);
        const command = {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Synthetic competing writer",
        };
        if (kind === "same-key finalize")
          return native.finalize(
            context.tenantId,
            context.actorUserId,
            last.created.id,
            last.finalizeInput,
            last.requestId,
          );
        if (kind === "same-key case") {
          const c = parseUsDatasetCasesResult(prepared.cases.receipt?.result);
          return new UsCaseStore(writer.db).link(
            context.tenantId,
            context.actorUserId,
            result.input.outputLotId,
            {
              operationKey: prepared.cases.intent.operationKey,
              ssccs: c.linked.created.map((row) => row.ssccAtLink),
            },
            "competing-case-key",
          );
        }
        if (kind === "amend" || kind === "void")
          return native[kind](
            context.tenantId,
            context.actorUserId,
            last.created.id,
            command,
            "public-lifecycle",
          );
        if (kind === "pending void")
          return native.void(
            context.tenantId,
            context.actorUserId,
            pendingId,
            { ...command, expectedLifecycleVersion: 3, expectedDraftVersion: 1 },
            "public-pending-void",
          );
        if (kind === "status")
          return stores.lots.changeStatus(
            context.tenantId,
            context.actorUserId,
            result.input.outputLotId,
            { status: "quarantined", expectedRevision: 1, reason: command.reason },
            "public-status",
          );
        if (kind === "source")
          return stores.lots.changeSource(
            context.tenantId,
            context.actorUserId,
            result.input.outputLotId,
            { source: result.originLot.source, expectedRevision: 1, reason: command.reason },
            "public-source",
          );
        if (kind === "consume") {
          if (!consume) throw new Error("Missing consumer");
          return native.finalize(
            context.tenantId,
            context.actorUserId,
            consume.id,
            {
              operationKey: command.operationKey,
              expectedDraftVersion: 1,
              expectedInputDigest: consume.digest,
            },
            "public-consume",
          );
        }
        const first = parseUsDatasetCasesResult(prepared.cases.receipt?.result).linked.created[0];
        if (!first) throw new Error("Missing case");
        return new UsCaseStore(writer.db).unlink(
          context.tenantId,
          context.actorUserId,
          result.input.outputLotId,
          first.linkId,
          { operationKey: command.operationKey, reason: command.reason },
          "public-unlink",
        );
      };
      if (order === "verifier first") {
        workers.reader = outcome(read());
        await abortable(
          Promise.race([
            acquired.promise,
            workers.reader.then((row) => {
              throw row.error ?? new Error("Verifier finished before barrier");
            }),
          ]),
          signal,
        );
        workers.writer = outcome(Promise.resolve().then(write));
        await waitBlocked(f, readerPid, writerPid, signal);
        await abortable(ready(), signal);
        release.release();
      } else {
        const gate = await gatePool.pool.connect();
        ownClient(own, gate, "root gate release before worker drain", () => gate.query("ROLLBACK"));
        await gate.query("BEGIN");
        await gate.query(
          "SELECT id FROM traceability_events WHERE tenant_id=$1 AND id=$2 FOR SHARE",
          [context.tenantId, pendingId ?? last.created.id],
        );
        workers.writer = outcome(Promise.resolve().then(write));
        await waitBlocked(f, gatePid, writerPid, signal);
        workers.reader = outcome(read());
        await waitBlocked(f, writerPid, readerPid, signal);
        // Writer holds the known Shipping root. Reader must wait before ANY lot.
        const probe = await f.pool.connect();
        try {
          await probe.query("BEGIN");
          const inbound = parseUsDatasetReceivingResult(prepared.receiving.receipt?.result);
          expect(
            (
              await probe.query(
                "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
                [
                  context.tenantId,
                  [...inbound.lots.map((lot) => lot.id), result.input.outputLotId],
                ],
              )
            ).rowCount,
          ).toBe(3);
        } finally {
          await probe.query("ROLLBACK");
          probe.release();
        }
        await abortable(ready(), signal);
        await gate.query("ROLLBACK");
      }
      expect((await workers.reader).error).toBeUndefined();
      const written = await workers.writer;
      if (kind === "source" || kind === "same-key case") expect(written.error).toBeDefined();
      else expect(written.error).toBeUndefined();
      signal.throwIfAborted();
    });
  }
  it.for([
    "amend",
    "void",
    "pending void",
    "status",
    "source",
    "unlink",
    "consume",
    "same-key finalize",
    "same-key case",
  ] as const)(
    "actual %s writer waits for verifier locks with independent PIDs",
    { timeout: 30000 },
    async (kind, test) => {
      const running = startObservation(test, (signal, ready) =>
        schedule(kind, "verifier first", signal, ready),
      );
      try {
        await running.ready;
        running.proceed();
        const result = await running.running;
        if (result.error) throw result.error;
      } finally {
        await running.cleanup();
      }
    },
  );
  it.for(["amend", "void", "pending void"] as const)(
    "%s writer owns root before verifier takes union lots",
    { timeout: 30000 },
    async (kind, test) => {
      const running = startObservation(test, (signal, ready) =>
        schedule(kind, "writer first", signal, ready),
      );
      try {
        await running.ready;
        running.proceed();
        const result = await running.running;
        if (result.error) throw result.error;
      } finally {
        await running.cleanup();
      }
    },
  );
  it("owned observation cancellation releases barriers and drains actual DB workers", async (test) => {
    let pids: number[] = [];
    const running = startObservation(test, (signal, ready) =>
      schedule("void", "verifier first", signal, ready, (owned) => {
        pids = owned;
      }),
    );
    try {
      await running.ready;
      running.abort.abort(new Error("task3_owned_cancel"));
      await running.cleanup();
      expect((await running.running).error).toMatchObject({ message: "task3_owned_cancel" });
    } finally {
      await running.cleanup();
    }
    expect(pids).toHaveLength(3);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS active FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
          [pids],
        )
      ).rows[0]?.active,
    ).toBe(0);
    console.info("Task3 actual cancelled workers drained; exact backends absent", { pids });
  }, 30000);
  it(
    "retains Shipping document shares before waiting for final Cases support locks",
    { timeout: 30000 },
    async (test) => {
      const running = startObservation(test, async (signal, ready) => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 0);
        const result = await new UsDatasetShippingSeedStore(f.db).initialize(context, 0);
        const stage = await datasetTransformationStores(f.db).journal.readStage(
          context,
          prepared.datasetId,
          prepared.intent.unitKey,
          "shipping",
        );
        if (!stage?.receipt || !base) throw new Error("Missing owned receipt");
        const receipt = stage.receipt;
        const boxId = parseUsDatasetCasesResult(prepared.cases.receipt?.result).input.support
          .boxes[0]?.id;
        const documentId = result.shipments[0]?.documents[0]?.record.id;
        if (!boxId || !documentId) throw new Error("Missing owned support");
        await withOwnedWork(async (own) => {
          const url = new URL(base);
          url.pathname = "/" + f.databaseName;
          const reader = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("tier reader pool", () => reader.pool.end());
          const workers: { running?: ReturnType<typeof outcome> } = {};
          own("actual tier worker drain", async () => {
            await workers.running;
          });
          const gate = await f.pool.connect();
          ownClient(own, gate, "support gate release before worker drain", () =>
            gate.query("ROLLBACK"),
          );
          const readerPid = (
            await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]?.pid;
          if (!readerPid || !gatePid) throw new Error("Missing tier PIDs");
          await gate.query("BEGIN");
          await gate.query("SELECT id FROM boxes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            context.tenantId,
            boxId,
          ]);
          workers.running = outcome(
            reader.db.transaction((tx) =>
              verifyUsDatasetShipping(
                tx,
                context,
                stage.intent,
                receipt,
                {
                  ...datasetTransformationStores(reader.db),
                  shipping: new UsShippingStore(reader.db),
                },
                "replay",
              ),
            ),
          );
          await waitBlocked(f, gatePid, readerPid, signal);
          const probe = await f.pool.connect();
          try {
            await probe.query("BEGIN");
            const error = await probe
              .query(
                "SELECT id FROM reference_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
                [context.tenantId, documentId],
              )
              .catch((cause: unknown) => cause);
            expect(driverCode(error)).toBe("55P03");
          } finally {
            await probe.query("ROLLBACK");
            probe.release();
          }
          await abortable(ready(), signal);
          await gate.query("ROLLBACK");
          expect((await workers.running).error).toBeUndefined();
        });
      });
      try {
        await running.ready;
        running.proceed();
        const result = await running.running;
        if (result.error) throw result.error;
      } finally {
        await running.cleanup();
      }
    },
  );
});
