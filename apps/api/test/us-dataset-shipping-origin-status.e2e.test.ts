import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  prepareDatasetShippingFixture,
  applyDatasetShippingFixture,
  applyDatasetShippingDriftFixture,
  type UsDatasetJournalFixture,
} from "./support/us-dataset-shipping-fixture";
import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetReceivingResult } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { verifyUsDatasetShippingOriginStatus } from "../src/modules/traceability/demo/us-dataset-shipping-origin-status";
import { lockUsDatasetTransformation } from "../src/modules/traceability/demo/us-dataset-transformation-locks";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import {
  abortable,
  barrier,
  driverCode,
  outcome,
  startObservation,
  withOwnedWork,
  waitBlocked,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Shipping origin status proof", () => {
  let f: UsDatasetJournalFixture;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US URL");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  type Prepared = Awaited<ReturnType<typeof prepareDatasetShippingFixture>>;
  async function proof(context: UsDatasetContext, prepared: Prepared) {
    const stores = datasetTransformationStores(f.db);
    if (!prepared.transformation.receipt || !prepared.receiving.receipt)
      throw new Error("Missing receipt");
    const expected = parseUsDatasetTransformationResult(prepared.transformation.receipt.result);
    const receiving = parseUsDatasetReceivingResult(prepared.receiving.receipt.result);
    return f.db.transaction(
      async (tx) => {
        await lockUsDatasetTransformation(tx, context, { receiving, transformation: expected });
        const current = await stores.lots.getLotInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          expected.outputLot.id,
        );
        await verifyUsDatasetShippingOriginStatus(tx, context, stores.journal, expected, current);
      },
      { isolationLevel: "read committed" },
    );
  }
  async function rejectProof(context: UsDatasetContext, prepared: Prepared) {
    const before = await f.snapshot();
    await expect(proof(context, prepared)).rejects.toThrow("us_dataset_transformation_mismatch");
    expect(await f.snapshot()).toEqual(before);
  }

  // Catches rejection of an exact native full Shipping status transition by upstream replay.
  it.each([1, 258, 259])(
    "replays both actual upstream stores after full chain %i without writes",
    async (index) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision();
        const prepared = await prepareDatasetShippingFixture(f, context, index);
        const result = await applyDatasetShippingFixture(f, context, prepared);
        expect(result.outputLotAfter).toMatchObject({ status: "shipped", revision: 2 });
        expect(
          await datasetTransformationStores(f.db).journal.readStage(
            context,
            prepared.datasetId,
            prepared.intent.unitKey,
            "shipping",
          ),
        ).toMatchObject({ revision: 1, receipt: null });
        const before = await f.snapshot();
        const upstream = await Promise.allSettled([
          new UsDatasetTransformationSeedStore(f.db).verify(context, index),
          new UsDatasetCasesSeedStore(f.db).verify(context, index),
        ]);
        expect(upstream).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }]);
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.each(["original active", "partial Shipping"])("keeps exact %s identity path", async (kind) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 0);
      if (kind === "partial Shipping") await applyDatasetShippingFixture(f, context, prepared);
      const before = await f.snapshot();
      await proof(context, prepared);
      await new UsDatasetTransformationSeedStore(f.db).verify(context, 0);
      await new UsDatasetCasesSeedStore(f.db).verify(context, 0);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each([
    "database",
    "foreign tenant",
    "malformed tenant",
    "role",
    "owner",
    "absent header",
  ] as const)("guards %s before both hostile evidence getters", async (kind) =>
    runDatasetCasesFixtureBody(async () => {
      let context = await f.provision();
      const prepared = await prepareDatasetShippingFixture(f, context, 258);
      if (!prepared.transformation.receipt) throw new Error("Missing receipt");
      const expected = parseUsDatasetTransformationResult(prepared.transformation.receipt.result);
      if (kind === "role")
        await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
          context.actorUserId,
        ]);
      if (kind === "owner")
        await f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
          "changed owner",
          context.actorUserId,
        ]);
      if (kind === "absent header") context = await f.provision();
      const checked = {
        ...context,
        expectedDatabaseName: kind === "database" ? "wrong_db" : context.expectedDatabaseName,
        tenantId:
          kind === "foreign tenant"
            ? randomUUID()
            : kind === "malformed tenant"
              ? "bad"
              : context.tenantId,
      };
      let touched = false;
      const hostileExpected = {
        ...expected,
        get input(): never {
          touched = true;
          throw new Error("hostile expected");
        },
      };
      const hostileCurrent = {
        ...expected.outputLot,
        get id(): never {
          touched = true;
          throw new Error("hostile current");
        },
      };
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          verifyUsDatasetShippingOriginStatus(
            tx,
            checked,
            datasetTransformationStores(f.db).journal,
            hostileExpected,
            hostileCurrent,
          ),
        ),
      ).rejects.toThrow(
        kind === "absent header" ? "us_dataset_conflict" : "us_dataset_target_invalid",
      );
      expect(touched).toBe(false);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each(["recalled", "active", "shipped"] as const)(
    "rejects actual manual %s status",
    async (status) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 258);
        const stores = datasetTransformationStores(f.db);
        if (status === "recalled") await applyDatasetShippingFixture(f, context, prepared);
        if (status === "active")
          await stores.lots.changeStatus(
            context.tenantId,
            context.actorUserId,
            prepared.input.outputLotId,
            { status: "quarantined", expectedRevision: 1, reason: "Synthetic manual quarantine" },
            "manual-quarantine",
          );
        await stores.lots.changeStatus(
          context.tenantId,
          context.actorUserId,
          prepared.input.outputLotId,
          {
            status,
            expectedRevision: status === "shipped" ? 1 : 2,
            reason: "Synthetic manual status",
          },
          "manual-status",
        );
        await rejectProof(context, prepared);
      }),
  );

  it.each(["amount", "operation key", "request"] as const)(
    "rejects actual full native Shipping with wrong %s",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 1);
        const applied = await applyDatasetShippingDriftFixture(f, context, prepared, kind);
        expect(applied.outputLotAfter).toMatchObject({ status: "shipped", revision: 2 });
        await rejectProof(context, prepared);
      }),
  );

  it.each(["source", "product"] as const)(
    "retains locked lot %s identity at the database boundary",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 258);
        await applyDatasetShippingFixture(f, context, prepared);
        const target = kind === "source" ? "source_location_id" : "product_id";
        const table = kind === "source" ? "traceability_locations" : "products";
        const before = await f.snapshot();
        const error = await f.pool
          .query(
            `UPDATE traceability_lots SET ${target}=(SELECT id FROM ${table} WHERE tenant_id=$1 AND id <> traceability_lots.${target} ORDER BY id LIMIT 1) WHERE tenant_id=$1 AND id=$2`,
            [context.tenantId, prepared.input.outputLotId],
          )
          .catch((cause: unknown) => cause);
        expect(driverCode(error)).toBe("23514");
        await proof(context, prepared);
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it.each([["creation clock", "created_at=created_at+interval '1 second'"]])(
    "rejects persisted lot %s drift",
    async (_kind, set) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 258);
        await applyDatasetShippingFixture(f, context, prepared);
        await f.pool.query(`UPDATE traceability_lots SET ${set} WHERE tenant_id=$1 AND id=$2`, [
          context.tenantId,
          prepared.input.outputLotId,
        ]);
        await rejectProof(context, prepared);
      }),
  );

  it("retains non-null creation actor at the database boundary", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 258);
      await applyDatasetShippingFixture(f, context, prepared);
      const before = await f.snapshot();
      const error = await f.pool
        .query("UPDATE traceability_lots SET created_by=NULL WHERE tenant_id=$1 AND id=$2", [
          context.tenantId,
          prepared.input.outputLotId,
        ])
        .catch((cause: unknown) => cause);
      expect(driverCode(error)).toBe("23502");
      await proof(context, prepared);
      expect(await f.snapshot()).toEqual(before);
    }));

  it.each([
    ["TLC", "tlc='SYNTHETIC-CHANGED'"],
    ["source lock", "source_locked_at=source_locked_at+interval '1 second'"],
  ])("retains locked lot %s identity at the DB boundary", async (_kind, set) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 258);
      await applyDatasetShippingFixture(f, context, prepared);
      const before = await f.snapshot();
      const error = await f.pool
        .query(`UPDATE traceability_lots SET ${set} WHERE tenant_id=$1 AND id=$2`, [
          context.tenantId,
          prepared.input.outputLotId,
        ])
        .catch((cause: unknown) => cause);
      expect(driverCode(error)).toBe("23514");
      await proof(context, prepared);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each(["missing", "wrong owner", "compensated", "clock"] as const)(
    "rejects native status effect %s drift",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 1);
        const applied = await applyDatasetShippingFixture(f, context, prepared);
        const statement =
          kind === "missing"
            ? "DELETE FROM shipping_lot_status_effects WHERE tenant_id=$1 AND lot_id=$2"
            : `UPDATE shipping_lot_status_effects SET ${kind === "wrong owner" ? "event_id=$3" : kind === "compensated" ? "compensated_at=now(),compensation_reason='Synthetic corruption'" : "created_at=created_at+interval '1 second'"} WHERE tenant_id=$1 AND lot_id=$2`;
        const before = await f.snapshot();
        const error = await f.pool
          .query(
            statement,
            kind === "wrong owner"
              ? [context.tenantId, prepared.input.outputLotId, applied.shipments[0]?.created.id]
              : [context.tenantId, prepared.input.outputLotId],
          )
          .catch((cause: unknown) => cause);
        if (kind === "compensated") await rejectProof(context, prepared);
        else {
          expect(driverCode(error)).toBe("23514");
          await proof(context, prepared);
          expect(await f.snapshot()).toEqual(before);
        }
      }),
  );

  it.each([
    ["actor", "actor_user_id=NULL"],
    ["action", "action='changed'"],
    ["outcome", "outcome='failure'"],
    ["target type", "target_type='changed'"],
    ["target", "target_id='changed'"],
    ["request", "request_id='changed'"],
    ["before", "before='{}'::jsonb"],
    ["after", "after='{}'::jsonb"],
    ["clock", "created_at=created_at+interval '1 second'"],
  ])("rejects allowed native status audit %s drift without repair", async (_kind, set) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 258);
      await applyDatasetShippingFixture(f, context, prepared);
      const updated = await f.pool.query(
        `UPDATE tenant_audit_events SET ${set} WHERE organization_id=$1 AND target_id=$2 AND action='traceability.lot.status_changed'`,
        [context.tenantId, prepared.input.outputLotId],
      );
      expect(updated.rowCount).toBe(1);
      await rejectProof(context, prepared);
    }),
  );

  it.each(["pending amendment", "pending draft void", "finalized void"] as const)(
    "rejects real Shipping %s lifecycle",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 258);
        const applied = await applyDatasetShippingFixture(f, context, prepared),
          last = applied.shipments.at(-1);
        if (!last) throw new Error("Missing native shipment");
        const shipping = new UsShippingStore(f.db),
          command = {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Synthetic lifecycle drift",
          };
        if (kind === "finalized void")
          await shipping.void(
            context.tenantId,
            context.actorUserId,
            last.created.id,
            command,
            "public-void",
          );
        else {
          const amendment = await shipping.amend(
            context.tenantId,
            context.actorUserId,
            last.created.id,
            command,
            "public-amend",
          );
          if (kind === "pending draft void")
            await shipping.void(
              context.tenantId,
              context.actorUserId,
              amendment.eventId,
              {
                ...command,
                operationKey: randomUUID(),
                expectedLifecycleVersion: 3,
                expectedDraftVersion: 1,
              },
              "public-pending-void",
            );
        }
        await rejectProof(context, prepared);
      }),
  );

  it("rejects a real full-to-full amendment transferring the native status owner", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 258);
      const applied = await applyDatasetShippingFixture(f, context, prepared),
        last = applied.shipments.at(-1);
      if (!last) throw new Error("Missing native shipment");
      const shipping = new UsShippingStore(f.db);
      const amendment = await shipping.amend(
        context.tenantId,
        context.actorUserId,
        last.created.id,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Synthetic owner transfer",
        },
        "owner-transfer-amend",
      );
      const ready = await shipping.checkReadiness(
        context.tenantId,
        context.actorUserId,
        amendment.eventId,
        { expectedDraftVersion: 1 },
      );
      expect(ready.state).toBe("complete");
      await shipping.finalize(
        context.tenantId,
        context.actorUserId,
        amendment.eventId,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "owner-transfer-finalize",
      );
      const owned = await f.pool.query<{ event_id: string }>(
        "SELECT event_id FROM shipping_lot_status_effects WHERE tenant_id=$1 AND lot_id=$2 AND compensated_at IS NULL",
        [context.tenantId, prepared.input.outputLotId],
      );
      expect(owned.rows).toEqual([{ event_id: amendment.eventId }]);
      expect(
        await datasetTransformationStores(f.db).lots.getLot(
          context.tenantId,
          context.actorUserId,
          prepared.input.outputLotId,
        ),
      ).toMatchObject({ status: "shipped", revision: 2 });
      await rejectProof(context, prepared);
    }));

  it("denies extra native consumption of zero remaining stock and keeps the proved status", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 258);
      const applied = await applyDatasetShippingFixture(f, context, prepared),
        last = applied.shipments.at(-1);
      if (!last) throw new Error("Missing native shipment");
      const shipping = new UsShippingStore(f.db);
      const extra = await shipping.createDraft(
        context.tenantId,
        context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            ...last.createInput.draft,
            items: [{ lotId: prepared.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
          },
        },
        "extra-native-draft",
      );
      const readiness = await shipping.checkReadiness(
        context.tenantId,
        context.actorUserId,
        extra.id,
        { expectedDraftVersion: 1 },
      );
      expect(readiness.state).toBe("incomplete");
      const before = await f.snapshot();
      await expect(
        shipping.finalize(
          context.tenantId,
          context.actorUserId,
          extra.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: readiness.inputDigest,
          },
          "extra-native-finalize",
        ),
      ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
      await proof(context, prepared);
      expect(await f.snapshot()).toEqual(before);
    }));

  it.each([
    [
      "operation command",
      "UPDATE shipping_operations SET command='shipping.save' WHERE tenant_id=$1",
    ],
    [
      "operation amount",
      "UPDATE shipping_operations SET result=jsonb_set(result,'{draft,items,0,quantity}','\"1\"') WHERE tenant_id=$1",
    ],
    [
      "operation actor",
      "UPDATE shipping_operations SET result=jsonb_set(result,'{createdBy}','null') WHERE tenant_id=$1",
    ],
    ["operation event", "UPDATE shipping_operations SET event_id=$2 WHERE tenant_id=$1"],
    [
      "operation digest",
      "UPDATE shipping_operations SET input_digest=repeat('0',64) WHERE tenant_id=$1",
    ],
    ["event amount", "UPDATE shipping_event_items SET quantity=1 WHERE tenant_id=$1"],
  ])("retains native immutability of %s and unchanged proof", async (_kind, statement) =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 1);
      const applied = await applyDatasetShippingFixture(f, context, prepared);
      const before = await f.snapshot();
      const error = await f.pool
        .query(
          statement,
          statement.includes("$2")
            ? [context.tenantId, applied.shipments[0]?.created.id]
            : [context.tenantId],
        )
        .catch((cause: unknown) => cause);
      expect(driverCode(error)).toBe("23514");
      await proof(context, prepared);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it("observes public pending-draft void committed while output lot lock is held", async (test) => {
    const observation = startObservation(test, (signal) =>
      withOwnedWork(async (own) => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 258);
        const applied = await applyDatasetShippingFixture(f, context, prepared),
          last = applied.shipments.at(-1);
        if (!last || !prepared.transformation.receipt || !prepared.receiving.receipt || !base)
          throw new Error("Missing race evidence");
        const url = new URL(base);
        url.pathname = "/" + f.databaseName;
        const reader = createDb(url.toString(), { max: 1, statement_timeout: 8000 }),
          writer = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
        own("reader-pool", () => reader.pool.end());
        own("writer-pool", () => writer.pool.end());
        const shipping = new UsShippingStore(writer.db);
        const amendment = await shipping.amend(
          context.tenantId,
          context.actorUserId,
          last.created.id,
          { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Synthetic race" },
          "race-amend",
        );
        const expected = parseUsDatasetTransformationResult(prepared.transformation.receipt.result),
          receiving = parseUsDatasetReceivingResult(prepared.receiving.receipt.result);
        const locked = barrier(),
          proceed = barrier();
        const work = outcome(
          reader.db.transaction(
            async (tx) => {
              await lockUsDatasetTransformation(tx, context, {
                receiving,
                transformation: expected,
              });
              locked.release();
              await proceed.promise;
              const stores = datasetTransformationStores(reader.db);
              await verifyUsDatasetShippingOriginStatus(
                tx,
                context,
                stores.journal,
                expected,
                await stores.lots.getLotInTransaction(
                  tx,
                  context.tenantId,
                  context.actorUserId,
                  expected.outputLot.id,
                ),
              );
            },
            { isolationLevel: "read committed" },
          ),
        );
        own("reader-drain", async () => {
          await work;
        });
        own("release-reader", async () => {
          proceed.release();
        });
        await abortable(
          Promise.race([
            locked.promise,
            work.then(({ error }) => {
              throw error ?? new Error("reader ended before lock");
            }),
          ]),
          signal,
        );
        const voidWork = outcome(
          shipping.void(
            context.tenantId,
            context.actorUserId,
            amendment.eventId,
            {
              operationKey: randomUUID(),
              expectedLifecycleVersion: 3,
              expectedDraftVersion: 1,
              reason: "Synthetic race void",
            },
            "race-pending-void",
          ),
        );
        own("void-drain", async () => {
          await voidWork;
        });
        const voided = await abortable(voidWork, signal);
        if (voided.error) throw voided.error;
        const before = await f.snapshot();
        proceed.release();
        expect((await work).error).toMatchObject({ message: "us_dataset_transformation_mismatch" });
        expect(await f.snapshot()).toEqual(before);
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
  });

  it.for(["amend", "finalized void"] as const)(
    "linearizes before real %s waiting on the held lot without locking its discovered root",
    async (kind, test) => {
      const observation = startObservation(test, (signal) =>
        withOwnedWork(async (own) => {
          const context = await f.provision(),
            prepared = await prepareDatasetShippingFixture(f, context, 258);
          const applied = await applyDatasetShippingFixture(f, context, prepared),
            last = applied.shipments.at(-1);
          if (!last || !prepared.transformation.receipt || !prepared.receiving.receipt || !base)
            throw new Error("Missing race evidence");
          const url = new URL(base);
          url.pathname = "/" + f.databaseName;
          const reader = createDb(url.toString(), { max: 1, statement_timeout: 8000 }),
            writer = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("reader-pool", () => reader.pool.end());
          own("writer-pool", () => writer.pool.end());
          const readerPid = (
              await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
            ).rows[0]?.pid,
            writerPid = (await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
              .rows[0]?.pid;
          if (!readerPid || !writerPid) throw new Error("Missing owned backend PID");
          const expected = parseUsDatasetTransformationResult(
              prepared.transformation.receipt.result,
            ),
            receiving = parseUsDatasetReceivingResult(prepared.receiving.receipt.result);
          const locked = barrier(),
            verify = barrier();
          const readerWork = outcome(
            reader.db.transaction(
              async (tx) => {
                await lockUsDatasetTransformation(tx, context, {
                  receiving,
                  transformation: expected,
                });
                locked.release();
                await verify.promise;
                const stores = datasetTransformationStores(reader.db);
                await verifyUsDatasetShippingOriginStatus(
                  tx,
                  context,
                  stores.journal,
                  expected,
                  await stores.lots.getLotInTransaction(
                    tx,
                    context.tenantId,
                    context.actorUserId,
                    expected.outputLot.id,
                  ),
                );
              },
              { isolationLevel: "read committed" },
            ),
          );
          own("reader-drain", async () => {
            await readerWork;
          });
          own("release-reader", async () => {
            verify.release();
          });
          await abortable(
            Promise.race([
              locked.promise,
              readerWork.then(({ error }) => {
                throw error ?? new Error("reader ended before lock");
              }),
            ]),
            signal,
          );
          const shipping = new UsShippingStore(writer.db),
            command = {
              operationKey: randomUUID(),
              expectedLifecycleVersion: 2,
              reason: "Synthetic blocked native writer",
            };
          const writerWork = outcome(
            kind === "amend"
              ? shipping.amend(
                  context.tenantId,
                  context.actorUserId,
                  last.created.id,
                  command,
                  "race-blocked-amend",
                )
              : shipping.void(
                  context.tenantId,
                  context.actorUserId,
                  last.created.id,
                  command,
                  "race-finalized-void",
                ),
          );
          own("writer-drain", async () => {
            verify.release();
            await readerWork;
            await writerWork;
          });
          await waitBlocked(f, readerPid, writerPid, signal);
          verify.release();
          const read = await readerWork;
          if (read.error) throw read.error;
          const written = await writerWork;
          if (written.error) throw written.error;
          await rejectProof(context, prepared);
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
    },
  );
});
