import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  insertDatasetCasesFixtureSupport,
  prepareDatasetCasesFixture,
  runDatasetCasesFixtureBody,
} from "./support/us-dataset-cases-fixture";
import { withOwnedWork } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Owned demo Cases application", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("creates native support and all links from a saved Cases intent", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const actual = await f.db.transaction((tx) =>
        new UsCaseStore(f.db).seedDemoInTransaction(
          tx,
          context,
          prepared.datasetId,
          prepared.intent.unitKey,
          "owned-demo-application",
        ),
      );
      expect(actual.input).toEqual(prepared.input);
      expect(actual.support.boxes).toHaveLength(55);
      expect(actual.linked.created).toHaveLength(55);
      expect(actual.linked.unchanged).toEqual([]);
      expect(actual.linked.created.every((link) => link.linkSource === "demo_seed")).toBe(true);
      expect(
        await f.db
          .select()
          .from(schema.traceLotBoxOperations)
          .where(eq(schema.traceLotBoxOperations.operationKey, prepared.intent.operationKey)),
      ).toHaveLength(1);
      const audits = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, context.tenantId),
            eq(schema.tenantAuditEvents.requestId, "owned-demo-application"),
          ),
        );
      expect(audits).toMatchObject([
        {
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          action: "case.link",
          outcome: "success",
          targetId: prepared.input.outputLotId,
        },
      ]);
      const stage = await new UsDatasetJournalStore(f.db, usSixMonthDefinition).readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "cases",
      );
      expect(stage?.receipt).toBeNull();
    }));

  it("rolls back all owned writes on a caller abort", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const before = await f.snapshot();
      const primary = new Error("caller abort after native application");
      await expect(
        f.db.transaction(async (tx) => {
          const actual = await new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            prepared.datasetId,
            prepared.intent.unitKey,
            "owned-demo-abort",
          );
          expect(actual.linked.created).toHaveLength(55);
          throw primary;
        }),
      ).rejects.toBe(primary);
      expect(await f.snapshot()).toEqual(before);
    }));

  it("rejects already inserted pending support without adopting it", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      await f.db.transaction((tx) => insertDatasetCasesFixtureSupport(tx, context, prepared.input));
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            prepared.datasetId,
            prepared.intent.unitKey,
            "owned-demo-no-adoption",
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      expect(await f.snapshot()).toEqual(before);
    }));

  it("denies a wrong actor before interpreting a hostile unit key", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            { ...context, actorUserId: randomUUID() },
            prepared.datasetId,
            "hostile unit key",
            "owned-demo-denied",
          ),
        ),
      ).rejects.toBeDefined();
      expect(await f.snapshot()).toEqual(before);
    }));

  it("rejects support-trigger ancestor drift at the unchanged final proof", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
      const pending = await journal.readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "cases",
      );
      await withOwnedWork(async (own) => {
        await f.pool.query(
          "CREATE FUNCTION synthetic_cases_ancestor_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE products SET name='trigger changed output product' WHERE id=NEW.product_id; RETURN NEW; END $$",
        );
        own("ancestor trigger function", () =>
          f.pool.query("DROP FUNCTION synthetic_cases_ancestor_drift()").then(() => {}),
        );
        await f.pool.query(
          "CREATE TRIGGER synthetic_cases_ancestor_drift AFTER INSERT ON shifts FOR EACH ROW EXECUTE FUNCTION synthetic_cases_ancestor_drift()",
        );
        own("ancestor trigger", () =>
          f.pool.query("DROP TRIGGER synthetic_cases_ancestor_drift ON shifts").then(() => {}),
        );
        const before = await f.snapshot();
        await expect(
          new UsDatasetCasesSeedStore(f.db).initialize(context, 0),
        ).rejects.toMatchObject({
          message: "us_dataset_cases_mismatch",
          cause: {
            message: "us_dataset_transformation_mismatch",
            cause: {
              message: "us_dataset_receiving_mismatch",
              cause: { message: "us_dataset_reference_mismatch" },
            },
          },
        });
        expect(await f.snapshot()).toEqual(before);
        expect(
          await journal.readStage(context, prepared.datasetId, prepared.intent.unitKey, "cases"),
        ).toEqual(pending);
      });
    }));

  it("rejects ancestor drift after the application returns at the unchanged final proof", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
      const pending = await journal.readStage(
        context,
        prepared.datasetId,
        prepared.intent.unitKey,
        "cases",
      );
      const before = await f.snapshot();
      const original = UsCaseStore.prototype.seedDemoInTransaction;
      const spy = vi
        .spyOn(UsCaseStore.prototype, "seedDemoInTransaction")
        .mockImplementation(async function (this: UsCaseStore, ...args) {
          const result = await original.apply(this, args);
          await args[0]
            .update(schema.products)
            .set({ name: "caller changed output product" })
            .where(eq(schema.products.id, result.input.outputProductId));
          return result;
        });
      try {
        await expect(
          new UsDatasetCasesSeedStore(f.db).initialize(context, 0),
        ).rejects.toMatchObject({
          message: "us_dataset_cases_mismatch",
          cause: {
            message: "us_dataset_transformation_mismatch",
            cause: {
              message: "us_dataset_receiving_mismatch",
              cause: { message: "us_dataset_reference_mismatch" },
            },
          },
        });
        expect(await f.snapshot()).toEqual(before);
        expect(
          await journal.readStage(context, prepared.datasetId, prepared.intent.unitKey, "cases"),
        ).toEqual(pending);
      } finally {
        spy.mockRestore();
      }
    }));
});
