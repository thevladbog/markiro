import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDatasetShippingFixture } from "./support/us-dataset-shipping-fixture";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetTraceReadinessStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { parseUsDatasetCasesResult } from "../src/modules/traceability/demo/us-dataset-cases-contract";
import type { UsDatasetShippingProjection } from "../src/modules/traceability/demo/us-dataset-shipping-projection";
import {
  chainTraceExpectation,
  checkDatasetTraceEvidence,
} from "../src/modules/traceability/demo/us-dataset-trace-readiness-evidence";
import {
  abortable,
  barrier,
  driverCode,
  outcome,
  ownClient,
  startObservation,
  waitBlocked,
  withOwnedWork,
} from "./support/us-transformation-lock-fixture";
import type { OwnedClient } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Shipping terminal native projection", () => {
  const h = specialFixture(base);
  const seed = () => new UsDatasetShippingSeedStore(h.f.db);
  async function completed(index = 0) {
    const prepared = await prepareDatasetShippingFixture(h.f, h.context, index);
    await seed().initialize(h.context, index);
    return prepared;
  }

  // Literal recreation of the accepted pre-projection path, using the real stores.
  async function acceptedProof(index: number) {
    const { f, context } = h;
    const header = await datasetTransformationStores(f.db).journal.read(context);
    if (!header) throw new Error("Missing reference header");
    const shipping = await seed().verify(context, index);
    const receiving = await new UsDatasetReceivingSeedStore(f.db).verify(context, index);
    const transformation = await new UsDatasetTransformationSeedStore(f.db).verify(context, index);
    const expected = chainTraceExpectation(
      receiving.finalized.record,
      receiving.lots,
      transformation,
      shipping.shipments,
      null,
    );
    const trace = new UsTraceStore(f.db),
      evidence = [];
    for (const lot of expected.lots) {
      const graph = await trace.read(context.tenantId, context.actorUserId, lot.id, {
        direction: "both",
      });
      const readiness = await trace.readiness(context.tenantId, context.actorUserId, {
        eventDateFrom: "2026-04-01",
        eventDateTo: "2026-09-30",
        lotId: lot.id,
      });
      const history = await trace.history(context.tenantId, context.actorUserId, lot.id, {
        limit: "100",
      });
      checkDatasetTraceEvidence(
        shipping.input.chain.unitKey,
        lot,
        expected,
        graph,
        readiness,
        history,
      );
      const { assessedAt, ...semantic } = readiness;
      void assessedAt;
      evidence.push({
        lotId: lot.id,
        traceDigest: canonicalExportDigest(graph),
        readinessDigest: canonicalExportDigest(semantic),
        historyDigest: canonicalExportDigest(history),
        originGap: false,
      });
    }
    return {
      native: { receiving, transformation, shipping },
      trace: {
        datasetId: header.id,
        version: header.version,
        definitionDigest: header.definitionDigest,
        unitKey: shipping.input.chain.unitKey,
        state: "trace_readiness_verified",
        datasetComplete: false,
        lotIds: expected.lots.map((lot) => lot.id),
        currentEventIds: expected.events.map((event) => event.id),
        evidence,
      },
    };
  }
  function ownedTree(left: unknown, right: unknown) {
    if (left === null || typeof left !== "object") return;
    expect(Object.isFrozen(left)).toBe(true);
    expect(left).not.toBe(right);
    for (const key of Object.keys(left))
      ownedTree(
        Reflect.get(left, key),
        right && typeof right === "object" ? Reflect.get(right, key) : undefined,
      );
  }

  type DriverPool = ReturnType<typeof createDb>["pool"];
  type DriverClient = OwnedClient;
  async function forwardQueries<T>(
    pool: DriverPool,
    intercept: (client: DriverClient, text: string, forward: () => unknown) => unknown,
    run: () => Promise<T>,
  ) {
    const restores = new Map<DriverClient, () => void>();
    function acquire(client: DriverClient) {
      if (restores.has(client)) return;
      const original = client.query;
      client.query = new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const raw = args[0];
          const text =
            typeof raw === "string"
              ? raw
              : raw && typeof raw === "object" && "text" in raw && typeof raw.text === "string"
                ? raw.text
                : "";
          return intercept(client, text, () => Reflect.apply(target, receiver, args));
        },
      });
      restores.set(client, () => {
        client.query = original;
      });
    }
    pool.on("acquire", acquire);
    try {
      return await run();
    } finally {
      pool.off("acquire", acquire);
      for (const restore of restores.values()) restore();
    }
  }

  it.each(["header", "references"] as const)(
    "refuses incomplete %s before any native work or writes",
    h.phase(async (kind) => {
      if (kind === "references")
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const before = await h.f.snapshot();
      await expect(seed().verifyTerminalProjection(h.context, 0)).rejects.toThrow(
        "us_dataset_shipping_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  describe("pending terminal stage", () => {
    beforeEach(
      h.phase(async () => {
        await prepareDatasetShippingFixture(h.f, h.context, 0);
      }),
      60000,
    );
    it(
      "refuses pending Shipping without adopting or creating native commands",
      h.phase(async () => {
        const before = await h.f.snapshot();
        await expect(seed().verifyTerminalProjection(h.context, 0)).rejects.toThrow(
          "us_dataset_shipping_prerequisite_incomplete",
        );
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );
  });

  for (const want of [
    { index: 0, shipments: 2 },
    { index: 1, shipments: 2 },
    { index: 259, shipments: 1 },
  ]) {
    describe(`exact chain ${want.index}`, () => {
      let reference: Awaited<
        ReturnType<typeof countActualQueries<Awaited<ReturnType<typeof acceptedProof>>>>
      >;
      let before: Awaited<ReturnType<typeof h.f.snapshot>>;
      beforeEach(
        h.phase(async () => {
          await completed(want.index);
          before = await h.f.snapshot();
          reference = await countActualQueries(h.f.pool, () => acceptedProof(want.index));
          expect(await h.f.snapshot()).toEqual(before);
        }),
        60000,
      );

      // Catches missing projection, skipped native proof, cross-call ownership and repeated SQL.
      it(
        "returns the exact live verified dependencies and reduces real regular proof reads",
        h.phase(async () => {
          expect(typeof Reflect.get(seed(), "verifyTerminalProjection")).toBe("function");
          const projection = await seed().verifyTerminalProjection(h.context, want.index);
          expect(projection).toEqual(reference.value.native);
          expect(projection.shipping.shipments).toHaveLength(want.shipments);
          ownedTree(projection, reference.value.native);
          expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(256 * 1024);
          const measured = await countActualQueries(h.f.pool, () =>
            new UsDatasetTraceReadinessStore(h.f.db).verify(h.context, {
              kind: "regular",
              index: want.index,
            }),
          );
          expect(measured.value).toEqual(reference.value.trace);
          expect(measured.count).toBeLessThan(reference.count);
          expect(await h.f.snapshot()).toEqual(before);
          console.info("Terminal projection native differential", {
            index: want.index,
            shipments: want.shipments,
            acceptedQueries: reference.count,
            projectionQueries: measured.count,
            acceptedMs: reference.durationMs,
            projectionMs: measured.durationMs,
            tables: Object.keys(before).length,
            hash: canonicalExportDigest(before),
          });
        }),
      );
    });
  }

  describe("completed native boundaries", () => {
    let prepared: Awaited<ReturnType<typeof completed>>;
    let projection: UsDatasetShippingProjection;
    beforeEach(
      h.phase(async () => {
        prepared = await completed();
        projection = await seed().verifyTerminalProjection(h.context, 0);
      }),
      60000,
    );

    it.each(["receiving", "transformation", "cases", "shipping", "reference"] as const)(
      "rejects live %s drift with old completed receipts and no repair",
      h.phase(async (kind) => {
        const { f, context } = h;
        const command = {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Owned projection drift",
        };
        if (kind === "receiving")
          await new UsReceivingStore(f.db).amend(
            context.tenantId,
            context.actorUserId,
            projection.receiving.created.eventId,
            { ...command, commandVersion: 2 },
            "projection-receiving",
          );
        if (kind === "transformation")
          await new UsTransformationStore(f.db).amend(
            context.tenantId,
            context.actorUserId,
            projection.transformation.finalized.id,
            command,
            "projection-transformation",
          );
        if (kind === "shipping")
          await new UsShippingStore(f.db).void(
            context.tenantId,
            context.actorUserId,
            projection.shipping.shipments[0]?.finalized.id,
            command,
            "projection-shipping",
          );
        if (kind === "cases") {
          const first = parseUsDatasetCasesResult(prepared.cases.receipt?.result).linked.created[0];
          if (!first) throw new Error("Missing owned case");
          await new UsCaseStore(f.db).unlink(
            context.tenantId,
            context.actorUserId,
            projection.shipping.input.outputLotId,
            first.linkId,
            { operationKey: command.operationKey, reason: command.reason },
            "projection-case",
          );
        }
        if (kind === "reference")
          expect(
            (
              await f.pool.query(
                "UPDATE products SET name=name||' drift' WHERE tenant_id=$1 AND id=$2",
                [context.tenantId, projection.shipping.input.outputProductId],
              )
            ).rowCount,
          ).toBe(1);
        const before = await f.snapshot();
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND receipt IS NOT NULL",
              [context.tenantId],
            )
          ).rows,
        ).toEqual([{ n: 5 }]);
        await expect(seed().verifyTerminalProjection(context, 0)).rejects.toMatchObject({
          message: expect.stringMatching(/^us_dataset_.*(mismatch|conflict)/),
          stage: "shipping",
          unitKey: "chain_0000",
        });
        expect(await f.snapshot()).toEqual(before);
      }),
    );

    it.each([
      "tenant",
      "original owner",
      "database",
      "user",
      "actual role",
      "membership",
      "profile",
    ] as const)(
      "rechecks %s on the next invocation before hostile selectors",
      h.phase(async (kind) => {
        const { f, context } = h;
        if (kind === "membership")
          await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        if (kind === "profile")
          await f.pool.query(
            "UPDATE org_profiles SET time_zone='America/New_York' WHERE tenant_id=$1",
            [context.tenantId],
          );
        const checked = {
          ...context,
          ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
          ...(kind === "original owner" ? { actorUserId: randomUUID() } : {}),
          ...(kind === "database" ? { expectedDatabaseName: "markiro_us_dev" } : {}),
          ...(kind === "user" ? { expectedDatabaseUser: "wrong_user" as "markiro_us" } : {}),
        };
        let touched = false;
        const hostile = {
          valueOf() {
            touched = true;
            throw new Error("hostile index");
          },
          get index() {
            touched = true;
            throw new Error("hostile selector");
          },
        };
        const db = kind === "actual role" ? await f.alternateRole() : f.db;
        const before = await f.snapshot();
        await expect(
          new UsDatasetShippingSeedStore(db).verifyTerminalProjection(
            checked,
            hostile as unknown as number,
          ),
        ).rejects.toThrow(/us_dataset_(target|context)_invalid/);
        expect(touched).toBe(false);
        expect(await f.snapshot()).toEqual(before);
      }),
    );

    it(
      "rejects malformed allowed selectors without writes",
      h.phase(async () => {
        const before = await h.f.snapshot();
        for (const index of [-1, 260, Number.NaN, -0])
          await expect(seed().verifyTerminalProjection(h.context, index)).rejects.toThrow(
            "us_dataset_shipping_input_invalid",
          );
        expect(await h.f.snapshot()).toEqual(before);
      }),
    );

    it.each(["missing", "pending", "legacy", "operation", "recordIds", "result"] as const)(
      "rejects %s prerequisite or evidence rather than adopting completed receipts",
      h.phase(async (kind) => {
        const { f, context } = h;
        await withOwnedWork(async (own) => {
          const c = await f.pool.connect();
          ownClient(own, c, "restore corruption transaction", () => c.query("ROLLBACK"));
          await c.query("BEGIN");
          await c.query("ALTER TABLE traceability_demo_dataset_stages DISABLE TRIGGER USER");
          const scope = "tenant_id=$1 AND unit_key='chain_0000' AND stage='transformation'";
          let changed;
          if (kind === "missing")
            changed = await c.query(`DELETE FROM traceability_demo_dataset_stages WHERE ${scope}`, [
              context.tenantId,
            ]);
          else if (kind === "pending")
            changed = await c.query(
              `UPDATE traceability_demo_dataset_stages SET receipt=NULL,revision=1 WHERE ${scope}`,
              [context.tenantId],
            );
          else if (kind === "operation")
            changed = await c.query(
              `UPDATE traceability_demo_dataset_stages SET operation_key=$2 WHERE ${scope}`,
              [context.tenantId, randomUUID()],
            );
          else {
            const receipt = prepared.transformation.receipt;
            if (!receipt) throw new Error("Missing original owned receipt");
            const result =
              kind === "result" ? { ...receipt.result, syntheticDrift: true } : receipt.result;
            const corrupted =
              kind === "legacy"
                ? { ...receipt, legacy: true }
                : {
                    ...receipt,
                    result,
                    resultDigest: canonicalExportDigest(result),
                    recordIds: kind === "recordIds" ? [randomUUID()] : receipt.recordIds,
                  };
            changed = await c.query(
              `UPDATE traceability_demo_dataset_stages SET receipt=$2::jsonb WHERE ${scope}`,
              [context.tenantId, JSON.stringify(corrupted)],
            );
          }
          expect(changed.rowCount).toBe(1);
          await c.query("ALTER TABLE traceability_demo_dataset_stages ENABLE TRIGGER USER");
          await c.query("COMMIT");
        });
        const before = await f.snapshot();
        await expect(seed().verifyTerminalProjection(context, 0)).rejects.toThrow(/^us_dataset_/);
        expect(await f.snapshot()).toEqual(before);
      }),
    );

    it.each(["query", "commit"] as const)(
      "propagates genuine %s driver failure with no escaped projection",
      h.phase(async (kind) => {
        const { f, context } = h;
        let terminal = false,
          injected = false,
          driverError: unknown,
          atomicError: unknown;
        if (kind === "commit") {
          await f.pool.query("CREATE TABLE projection_commit_probe (id integer PRIMARY KEY)");
          await f.pool.query(
            "CREATE FUNCTION projection_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_projection_commit_failure' USING ERRCODE='40001'; END $$",
          );
          await f.pool.query(
            "CREATE CONSTRAINT TRIGGER projection_deferred_failure AFTER INSERT ON projection_commit_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projection_commit_failure()",
          );
        }
        const before = await f.snapshot();
        const original = UsDatasetJournalStore.prototype.runAtomicStage;
        const atomic = vi
          .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
          .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
            try {
              return await original.apply(this, args);
            } catch (error) {
              atomicError = error;
              throw error;
            }
          });
        try {
          const observed = await forwardQueries(
            f.pool,
            (client, text, forward) => {
              if (/traceability_demo_dataset_stages/i.test(text) && /for update/i.test(text))
                terminal = true;
              if (
                !injected &&
                kind === "query" &&
                terminal &&
                /from "receiving_operations"/i.test(text)
              ) {
                injected = true;
                return client
                  .query("SELECT owned_projection_missing_column FROM receiving_operations")
                  .catch((error: unknown) => {
                    driverError = error;
                    throw error;
                  });
              }
              if (!injected && kind === "commit" && terminal && /^commit$/i.test(text.trim())) {
                injected = true;
                return client
                  .query("INSERT INTO projection_commit_probe VALUES (1)")
                  .then(async () => {
                    try {
                      return await forward();
                    } catch (error) {
                      driverError = error;
                      throw error;
                    }
                  });
              }
              return forward();
            },
            () => outcome(seed().verifyTerminalProjection(context, 0)),
          );
          expect(injected).toBe(true);
          expect(observed.value).toBeUndefined();
          expect(observed.error).toBe(atomicError);
          expect(driverCode(observed.error)).toBe(kind === "query" ? "42703" : "40001");
          expect(observed.error).toBeInstanceOf(Error);
          if (!(observed.error instanceof Error)) throw new Error("Missing original native error");
          expect(observed.error.cause).toBe(driverError);
          expect(await f.snapshot()).toEqual(before);
        } finally {
          atomic.mockRestore();
          if (kind === "commit") {
            await f.pool.query("DROP TABLE projection_commit_probe");
            await f.pool.query("DROP FUNCTION projection_commit_failure()");
          }
        }
      }),
    );

    const writers = ["receiving", "transformation", "shipping", "reference"] as const;
    it.for(
      writers.flatMap((kind) =>
        (["verifier first", "writer first"] as const).map((order) => ({ kind, order })),
      ),
    )(
      "retains native $kind locks in $order order with real blocker PIDs",
      async (testCase, test) => {
        const observation = startObservation(test, async (signal, ready) => {
          await withOwnedWork(async (own) => {
            if (!base) throw new Error("Missing isolated US URL");
            const { f, context } = h;
            const url = new URL(base);
            url.pathname = "/" + f.databaseName;
            const reader = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
            const writer = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
            own("reader pool", () => reader.pool.end());
            own("writer pool", () => writer.pool.end());
            const readerPid = (
              await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            ).rows[0]?.pid;
            const writerPid = (
              await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            ).rows[0]?.pid;
            if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
            expect(readerPid).not.toBe(writerPid);
            const reached = barrier(),
              release = barrier();
            const work: {
              reader?: ReturnType<typeof outcome>;
              writer?: ReturnType<typeof outcome>;
            } = {};
            own("release barriers and drain exact workers", async () => {
              release.release();
              await Promise.all([work.reader, work.writer]);
            });
            const write = (): Promise<unknown> => {
              const command = {
                operationKey: randomUUID(),
                expectedLifecycleVersion: 2,
                reason: "Owned projection lock writer",
              };
              if (testCase.kind === "receiving")
                return new UsReceivingStore(writer.db).amend(
                  context.tenantId,
                  context.actorUserId,
                  projection.receiving.created.eventId,
                  { ...command, commandVersion: 2 },
                  "projection-lock-receiving",
                );
              if (testCase.kind === "transformation")
                return new UsTransformationStore(writer.db).amend(
                  context.tenantId,
                  context.actorUserId,
                  projection.transformation.finalized.id,
                  command,
                  "projection-lock-transformation",
                );
              if (testCase.kind === "shipping")
                return new UsShippingStore(writer.db).void(
                  context.tenantId,
                  context.actorUserId,
                  projection.shipping.shipments[0]?.finalized.id,
                  command,
                  "projection-lock-shipping",
                );
              return writer.db.transaction(async (tx) =>
                tx.execute(
                  sql`UPDATE products SET name=name||' locked drift' WHERE tenant_id=${context.tenantId} AND id=${projection.shipping.input.outputProductId}`,
                ),
              );
            };
            const read = () =>
              new UsDatasetShippingSeedStore(reader.db).verifyTerminalProjection(context, 0);
            let terminal = false;
            const holdCommit = (pool: DriverPool, run: () => Promise<unknown>, native: boolean) =>
              forwardQueries(
                pool,
                (_client, text, forward) => {
                  if (/traceability_demo_dataset_stages/i.test(text) && /for update/i.test(text))
                    terminal = true;
                  if ((!native || terminal) && /^commit$/i.test(text.trim())) {
                    reached.release();
                    return release.promise.then(forward);
                  }
                  return forward();
                },
                run,
              );
            const first = testCase.order === "verifier first" ? "reader" : "writer";
            work[first] = outcome(
              first === "reader"
                ? holdCommit(reader.pool, read, true)
                : holdCommit(writer.pool, write, false),
            );
            await abortable(
              Promise.race([
                reached.promise,
                work[first].then(({ error }) => {
                  throw error ?? new Error("Worker ended before retained-commit barrier");
                }),
              ]),
              signal,
            );
            if (first === "reader") {
              work.writer = outcome(write());
              await waitBlocked(f, readerPid, writerPid, signal);
            } else {
              work.reader = outcome(read());
              await waitBlocked(f, writerPid, readerPid, signal);
            }
            await ready();
            release.release();
            const written = await work.writer,
              readResult = await work.reader;
            expect(written?.error).toBeUndefined();
            if (first === "reader") {
              expect(readResult?.error).toBeUndefined();
              expect(readResult?.value).toEqual(projection);
            } else {
              expect(readResult?.value).toBeUndefined();
              expect(readResult?.error).toMatchObject({
                stage: "shipping",
                unitKey: "chain_0000",
                message: expect.stringMatching(/mismatch|conflict/),
              });
            }
            const before = await f.snapshot();
            await expect(seed().verifyTerminalProjection(context, 0)).rejects.toThrow(
              /mismatch|conflict/,
            );
            expect(await f.snapshot()).toEqual(before);
          });
        });
        await observation.ready;
        observation.proceed();
        const result = await observation.running;
        if (result.error) throw result.error;
      },
    );

    it("rejects a real writer committed after terminal COMMIT and before actual read-model calls", async (test) => {
      const { f, context } = h;
      if (!base) throw new Error("Missing isolated US URL");
      const url = new URL(base);
      url.pathname = "/" + f.databaseName;
      const writer = createDb(url.toString(), { max: 1 });
      const terminalCommitted = barrier(),
        allowReadModels = barrier();
      const original = UsDatasetShippingSeedStore.prototype.verifyTerminalProjection;
      let native: UsDatasetShippingProjection | undefined;
      const projected = vi
        .spyOn(UsDatasetShippingSeedStore.prototype, "verifyTerminalProjection")
        .mockImplementation(async function (this: UsDatasetShippingSeedStore, ...args) {
          native = await original.apply(this, args);
          terminalCommitted.release();
          await allowReadModels.promise;
          return native;
        });
      const proof = outcome(
        new UsDatasetTraceReadinessStore(f.db).verify(context, { kind: "regular", index: 0 }),
      );
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        allowReadModels.release();
        await proof;
        projected.mockRestore();
        await writer.pool.end();
      };
      test.onTestFinished(cleanup);
      try {
        await abortable(
          Promise.race([
            terminalCommitted.promise,
            proof.then(({ error }) => {
              throw error ?? new Error("Proof finished before native COMMIT barrier");
            }),
          ]),
          test.signal,
        );
        expect(native).toEqual(projection);
        await new UsShippingStore(writer.db).void(
          context.tenantId,
          context.actorUserId,
          projection.shipping.shipments[0]?.finalized.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Writer at native/read-model boundary",
          },
          "projection-after-commit",
        );
        const before = await f.snapshot();
        allowReadModels.release();
        const result = await proof;
        expect(result.value).toBeUndefined();
        expect(result.error).toMatchObject({
          message: "us_dataset_trace_readiness_mismatch",
          stage: "trace",
          unitKey: "chain_0000",
        });
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await cleanup();
      }
    });
  });
});
