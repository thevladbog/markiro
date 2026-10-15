import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { prepareDatasetShippingFixture } from "./support/us-dataset-shipping-fixture";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Shipping prerequisite batch native boundaries", () => {
  const h = specialFixture(base);
  const seed = () => new UsDatasetShippingSeedStore(h.f.db);
  const unit = (index: number) => `chain_${String(index).padStart(4, "0")}`;
  const addresses = (index: number) => [
    { unitKey: "references", stage: "references" as const },
    { unitKey: unit(index), stage: "receiving" as const },
    { unitKey: unit(index), stage: "transformation" as const },
    { unitKey: unit(index), stage: "cases" as const },
  ];

  it.each(["references", "receiving", "transformation", "cases"] as const)(
    "stops before Shipping on missing %s with exact no-write snapshot",
    h.phase(async (stage) => {
      const { f, context } = h;
      const prepared = await prepareDatasetShippingFixture(f, context, 0);
      await f.pool.query(
        "DELETE FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND stage=$2 AND unit_key=$3",
        [context.tenantId, stage, stage === "references" ? "references" : unit(0)],
      );
      const before = await f.snapshot();
      const later = vi.spyOn(UsDatasetJournalStore.prototype, "readStage");
      const capture = vi.spyOn(UsDatasetJournalStore.prototype, "captureIntent");
      const atomic = vi.spyOn(UsDatasetJournalStore.prototype, "runAtomicStage");
      try {
        for (const action of [
          () => seed().initialize(context, 0),
          () => seed().verify(context, 0),
        ]) {
          await expect(action()).rejects.toMatchObject({
            message: "us_dataset_shipping_prerequisite_incomplete",
            unitKey: unit(0),
            stage: "shipping",
          });
        }
        expect(later).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(atomic).not.toHaveBeenCalled();
        expect(await f.snapshot()).toEqual(before);
        expect(prepared.intent.stage).toBe("shipping");
      } finally {
        vi.restoreAllMocks();
      }
    }),
    30_000,
  );

  it.each(["references", "receiving", "transformation", "cases"] as const)(
    "stops before Shipping on pending %s with exact no-write snapshot",
    h.phase(async (stage) => {
      const { f, context } = h;
      await prepareDatasetShippingFixture(f, context, 0);
      await f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET revision=1,receipt=NULL WHERE tenant_id=$1 AND stage=$2 AND unit_key=$3",
        [context.tenantId, stage, stage === "references" ? "references" : unit(0)],
      );
      const before = await f.snapshot();
      const later = vi.spyOn(UsDatasetJournalStore.prototype, "readStage");
      const capture = vi.spyOn(UsDatasetJournalStore.prototype, "captureIntent");
      const atomic = vi.spyOn(UsDatasetJournalStore.prototype, "runAtomicStage");
      try {
        for (const action of [() => seed().initialize(context, 0), () => seed().verify(context, 0)])
          await expect(action()).rejects.toMatchObject({
            message: "us_dataset_shipping_prerequisite_incomplete",
            unitKey: unit(0),
            stage: "shipping",
          });
        expect(later).not.toHaveBeenCalled();
        expect(capture).not.toHaveBeenCalled();
        expect(atomic).not.toHaveBeenCalled();
        expect(await f.snapshot()).toEqual(before);
      } finally {
        vi.restoreAllMocks();
      }
    }),
    30_000,
  );

  it.each([
    "missing plus corrupt",
    "pending plus corrupt Shipping",
    "identity plus corrupt Shipping",
  ] as const)(
    "keeps earlier diagnostic phase: %s",
    h.phase(async (kind) => {
      const { f, context } = h;
      await prepareDatasetShippingFixture(f, context, 0);
      if (kind === "missing plus corrupt") {
        await f.pool.query(
          "DELETE FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='references' AND stage='references'",
          [context.tenantId],
        );
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET input_digest=repeat('0',64) WHERE tenant_id=$1 AND unit_key=$2 AND stage='cases'",
          [context.tenantId, unit(0)],
        );
      } else {
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET input_digest=repeat('0',64) WHERE tenant_id=$1 AND unit_key=$2 AND stage='shipping'",
          [context.tenantId, unit(0)],
        );
        if (kind === "pending plus corrupt Shipping")
          await f.pool.query(
            "UPDATE traceability_demo_dataset_stages SET revision=1,receipt=NULL WHERE tenant_id=$1 AND unit_key=$2 AND stage='cases'",
            [context.tenantId, unit(0)],
          );
        else {
          const result = {};
          await f.pool.query(
            "UPDATE traceability_demo_dataset_stages SET input=$2::jsonb,input_digest=$3 WHERE tenant_id=$1 AND unit_key='references' AND stage='references'",
            [context.tenantId, JSON.stringify(result), canonicalExportDigest(result)],
          );
        }
      }
      const before = await f.snapshot();
      const shippingRead = vi.spyOn(UsDatasetJournalStore.prototype, "readStage");
      try {
        const error = await seed()
          .initialize(context, 0)
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ unitKey: unit(0), stage: "shipping" });
        expect(error).toBeInstanceOf(Error);
        if (kind === "missing plus corrupt")
          expect((error as Error).message).toBe("us_dataset_journal_invalid");
        else if (kind === "pending plus corrupt Shipping")
          expect((error as Error).message).toBe("us_dataset_shipping_prerequisite_incomplete");
        else expect((error as Error).message).toBe("us_dataset_receiving_dependency_conflict");
        expect(shippingRead).not.toHaveBeenCalled();
        expect(await f.snapshot()).toEqual(before);
      } finally {
        vi.restoreAllMocks();
      }
    }),
    30_000,
  );

  it(
    "checks target and header before a hostile selector, then reports valid-header invalid input",
    h.phase(async () => {
      const { f, context } = h;
      const hostile = {
        [Symbol.toPrimitive]() {
          throw new Error("hostile_selector_inspected");
        },
      } as unknown as number;
      const before = await f.snapshot();
      await expect(
        seed().initialize({ ...context, expectedDatabaseName: "markiro_us_dev" }, hostile),
      ).rejects.toMatchObject({ message: "us_dataset_target_invalid", stage: "shipping" });
      await expect(seed().initialize(context, hostile)).rejects.toMatchObject({
        message: "us_dataset_shipping_prerequisite_incomplete",
        unitKey: "unknown",
        stage: "shipping",
      });
      expect(await f.snapshot()).toEqual(before);
      await datasetTransformationStores(f.db).journal.initialize(context);
      const installed = await f.snapshot();
      await expect(seed().initialize(context, -1)).rejects.toMatchObject({
        message: "us_dataset_shipping_input_invalid",
        unitKey: "unknown",
        stage: "shipping",
      });
      expect(await f.snapshot()).toEqual(installed);
    }),
  );

  it.each(["membership", "profile"] as const)(
    "rejects committed %s drift after preflight before initialize capture",
    h.phase(async (kind) => {
      const { f, context } = h;
      await prepareDatasetShippingFixture(f, context, 0);
      const original = UsDatasetJournalStore.prototype.readStages;
      let afterDrift: Awaited<ReturnType<typeof f.snapshot>> | undefined;
      vi.spyOn(UsDatasetJournalStore.prototype, "readStages").mockImplementation(async function (
        this: UsDatasetJournalStore,
        ...args
      ) {
        const rows = await original.apply(this, args);
        if (kind === "membership")
          await f.pool.query("UPDATE member SET role='member' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        else
          await f.pool.query(
            "UPDATE org_profiles SET time_zone='America/Chicago' WHERE tenant_id=$1",
            [context.tenantId],
          );
        afterDrift = await f.snapshot();
        return rows;
      });
      try {
        await expect(seed().initialize(context, 0)).rejects.toMatchObject({
          message: "us_dataset_target_invalid",
          unitKey: unit(0),
          stage: "shipping",
        });
        expect(afterDrift).toBeDefined();
        expect(await f.snapshot()).toEqual(afterDrift);
      } finally {
        vi.restoreAllMocks();
      }
    }),
    30_000,
  );

  it(
    "retains only the captured pending intent when committed business drift rejects atomic initialize",
    h.phase(async () => {
      const { f, context } = h;
      const prepared = await prepareDatasetShippingFixture(f, context, 0);
      await f.pool.query(
        "DELETE FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key=$2 AND stage='shipping'",
        [context.tenantId, unit(0)],
      );
      const before = await f.snapshot();
      const original = UsDatasetJournalStore.prototype.captureIntent;
      let afterCapture: Awaited<ReturnType<typeof f.snapshot>> | undefined;
      let capturedKey: string | undefined;
      vi.spyOn(UsDatasetJournalStore.prototype, "captureIntent").mockImplementation(async function (
        this: UsDatasetJournalStore,
        ...args
      ) {
        const captured = await original.apply(this, args);
        capturedKey = captured.intent.operationKey;
        const changed = await f.pool.query(
          "UPDATE products SET name=name||' committed drift' WHERE tenant_id=$1 AND id=$2",
          [context.tenantId, prepared.input.outputProductId],
        );
        expect(changed.rowCount).toBe(1);
        afterCapture = await f.snapshot();
        return captured;
      });
      try {
        const error = await seed()
          .initialize(context, 0)
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ unitKey: unit(0), stage: "shipping" });
        expect((error as Error).message).toBe("us_dataset_cases_mismatch");
        console.info("Shipping interphase committed business drift", {
          code: (error as Error).message,
        });
        expect(afterCapture).toBeDefined();
        expect(afterCapture).not.toEqual(before);
        expect(await f.snapshot()).toEqual(afterCapture);
        const pending = await datasetTransformationStores(f.db).journal.readStage(
          context,
          prepared.datasetId,
          unit(0),
          "shipping",
        );
        expect(pending).toMatchObject({
          revision: 1,
          receipt: null,
          intent: { operationKey: capturedKey },
        });
      } finally {
        vi.restoreAllMocks();
      }
    }),
    30_000,
  );

  it.each(["membership", "profile", "business"] as const)(
    "rejects committed %s drift after preflight before completed verify",
    h.phase(async (kind) => {
      const { f, context } = h;
      const prepared = await prepareDatasetShippingFixture(f, context, 0);
      await seed().initialize(context, 0);
      const original = UsDatasetJournalStore.prototype.readStages;
      let afterDrift: Awaited<ReturnType<typeof f.snapshot>> | undefined;
      vi.spyOn(UsDatasetJournalStore.prototype, "readStages").mockImplementation(async function (
        this: UsDatasetJournalStore,
        ...args
      ) {
        const rows = await original.apply(this, args);
        if (kind === "membership")
          await f.pool.query("UPDATE member SET role='member' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        else if (kind === "profile")
          await f.pool.query(
            "UPDATE org_profiles SET time_zone='America/Chicago' WHERE tenant_id=$1",
            [context.tenantId],
          );
        else
          await f.pool.query(
            "UPDATE products SET name=name||' committed drift' WHERE tenant_id=$1 AND id=$2",
            [context.tenantId, prepared.input.outputProductId],
          );
        afterDrift = await f.snapshot();
        return rows;
      });
      try {
        const error = await seed()
          .verify(context, 0)
          .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ unitKey: unit(0), stage: "shipping" });
        expect((error as Error).message).toBe(
          kind === "business" ? "us_dataset_cases_mismatch" : "us_dataset_target_invalid",
        );
        console.info("Shipping completed verify interphase drift", {
          kind,
          code: (error as Error).message,
        });
        expect(afterDrift).toBeDefined();
        expect(await f.snapshot()).toEqual(afterDrift);
      } finally {
        vi.restoreAllMocks();
      }
    }),
    30_000,
  );

  it(
    "measures an early missing-prerequisite failure without later writes",
    h.phase(async () => {
      const { f, context } = h;
      await prepareDatasetShippingFixture(f, context, 0);
      await f.pool.query(
        "DELETE FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='references' AND stage='references'",
        [context.tenantId],
      );
      const before = await f.snapshot();
      const failure = await countActualQueries(f.pool, () =>
        seed()
          .initialize(context, 0)
          .catch((cause: unknown) => cause),
      );
      expect(failure.value).toMatchObject({
        message: "us_dataset_shipping_prerequisite_incomplete",
        unitKey: unit(0),
        stage: "shipping",
      });
      expect(await f.snapshot()).toEqual(before);
      console.info("Shipping early failure actual phase", {
        count: failure.count,
        durationMs: failure.durationMs,
      });
    }),
    30_000,
  );

  it.each([0, 1, 181, 259])(
    "measures actual scalar and batch preflight plus whole Shipping phases at %i",
    h.phase(async (index) => {
      const { f, context } = h;
      const prepared = await prepareDatasetShippingFixture(f, context, index);
      const journal = datasetTransformationStores(f.db).journal;
      const requested = addresses(index);
      const before = await f.snapshot();
      const scalar = await countActualQueries(f.pool, async () => {
        const result = [];
        for (const address of requested)
          result.push(
            await journal.readStage(context, prepared.datasetId, address.unitKey, address.stage),
          );
        return result;
      });
      const batch = await countActualQueries(f.pool, () =>
        journal.readStages(context, prepared.datasetId, requested),
      );
      expect(batch.value).toEqual(scalar.value);
      expect(batch.value).toEqual([
        prepared.references,
        prepared.receiving,
        prepared.transformation,
        prepared.cases,
      ]);
      expect(scalar.count).toBe(32);
      expect(batch.count).toBe(8);
      expect(await f.snapshot()).toEqual(before);
      const initialize = await countActualQueries(f.pool, () => seed().initialize(context, index));
      const after = await f.snapshot();
      const verify = await countActualQueries(f.pool, () => seed().verify(context, index));
      const replay = await countActualQueries(f.pool, () => seed().initialize(context, index));
      expect(verify.value).toEqual(initialize.value);
      expect(replay.value).toEqual(initialize.value);
      expect(await f.snapshot()).toEqual(after);
      console.info("Shipping actual phase measurements", {
        index,
        scalar: { count: scalar.count, durationMs: scalar.durationMs },
        batch: { count: batch.count, durationMs: batch.durationMs },
        initialize: { count: initialize.count, durationMs: initialize.durationMs },
        verify: { count: verify.count, durationMs: verify.durationMs },
        replay: { count: replay.count, durationMs: replay.durationMs },
        tables: Object.keys(after).length,
        afterDigest: canonicalExportDigest(after),
      });
    }),
    60_000,
  );

  it(
    "measures a small populated range on one owned dataset",
    h.phase(async () => {
      const { f, context } = h;
      const prepared: Awaited<ReturnType<typeof prepareDatasetShippingFixture>>[] = [];
      for (const index of [2, 3, 4])
        prepared.push(await prepareDatasetShippingFixture(f, context, index));
      const journal = datasetTransformationStores(f.db).journal;
      const before = await f.snapshot();
      for (const [position, index] of [2, 3, 4].entries()) {
        const rows = addresses(index);
        const scalar = await countActualQueries(f.pool, async () => {
          const values = [];
          for (const row of rows)
            values.push(
              await journal.readStage(
                context,
                prepared[position]!.datasetId,
                row.unitKey,
                row.stage,
              ),
            );
          return values;
        });
        const batch = await countActualQueries(f.pool, () =>
          journal.readStages(context, prepared[position]!.datasetId, rows),
        );
        expect(batch.value).toEqual(scalar.value);
        expect(scalar.count).toBe(32);
        expect(batch.count).toBe(8);
        console.info("Shipping populated range prerequisite", {
          index,
          scalarCount: scalar.count,
          batchCount: batch.count,
          scalarMs: scalar.durationMs,
          batchMs: batch.durationMs,
        });
      }
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );
});
