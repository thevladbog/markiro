import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { caseDemoCommandDigest } from "../src/modules/traceability/demo/us-dataset-cases-contract";
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
      const shift = await f.db
        .select()
        .from(schema.shifts)
        .where(eq(schema.shifts.id, prepared.input.support.shiftId));
      expect(shift).toMatchObject([
        {
          id: actual.support.shift.id,
          tenantId: context.tenantId,
          productId: prepared.input.outputProductId,
          status: "planned",
          mode: "aggregation",
          numberMonthKey: prepared.input.support.numberMonthKey,
          numberSeq: prepared.input.support.numberSeq,
        },
      ]);
      const boxes = await f.db
        .select()
        .from(schema.boxes)
        .where(eq(schema.boxes.shiftId, prepared.input.support.shiftId));
      expect(
        boxes
          .map((box) => ({ id: box.id, deviceBoxId: box.deviceBoxId, sscc: box.sscc }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([...prepared.input.support.boxes].sort((a, b) => a.id.localeCompare(b.id)));
      const markers = await f.db
        .select()
        .from(schema.traceabilitySyntheticCaseOrigins)
        .where(eq(schema.traceabilitySyntheticCaseOrigins.tenantId, context.tenantId));
      expect(
        markers
          .map((marker) => ({
            boxId: marker.boxId,
            seedId: marker.seedId,
            seedVersion: marker.seedVersion,
          }))
          .sort((a, b) => a.boxId.localeCompare(b.boxId)),
      ).toEqual(
        [...actual.support.markers]
          .map((marker) => ({
            boxId: marker.boxId,
            seedId: marker.seedId,
            seedVersion: marker.seedVersion,
          }))
          .sort((a, b) => a.boxId.localeCompare(b.boxId)),
      );
      const links = await f.db
        .select()
        .from(schema.traceLotBoxes)
        .where(eq(schema.traceLotBoxes.lotId, prepared.input.outputLotId));
      expect(
        links
          .map((link) => ({
            boxId: link.boxId,
            sscc: link.ssccAtLink,
            tenantId: link.tenantId,
            lotId: link.lotId,
            source: link.linkSource,
            linkedBy: link.linkedBy,
            unlinkedAt: link.unlinkedAt,
          }))
          .sort((a, b) => a.boxId.localeCompare(b.boxId)),
      ).toEqual(
        [...prepared.input.support.boxes]
          .map((box) => ({
            boxId: box.id,
            sscc: box.sscc,
            tenantId: context.tenantId,
            lotId: prepared.input.outputLotId,
            source: "demo_seed",
            linkedBy: context.actorUserId,
            unlinkedAt: null,
          }))
          .sort((a, b) => a.boxId.localeCompare(b.boxId)),
      );
      const operations = await f.db
        .select()
        .from(schema.traceLotBoxOperations)
        .where(eq(schema.traceLotBoxOperations.operationKey, prepared.intent.operationKey));
      expect(operations).toHaveLength(1);
      const operation = operations[0];
      if (!operation) throw new Error("Missing native Cases operation");
      expect(operation).toMatchObject({
        tenantId: context.tenantId,
        command: "case.link",
        operationKey: prepared.intent.operationKey,
        inputDigest: caseDemoCommandDigest(prepared.input),
        targetId: prepared.input.outputLotId,
        result: actual.linked,
      });
      const audits = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, context.tenantId),
            eq(schema.tenantAuditEvents.requestId, "owned-demo-application"),
          ),
        );
      expect(audits).toEqual([
        {
          id: audits[0]?.id,
          createdAt: operation.createdAt,
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          action: "case.link",
          outcome: "success",
          targetType: "traceability_lot",
          targetId: prepared.input.outputLotId,
          requestId: "owned-demo-application",
          before: { links: [] },
          after: {
            tenantId: context.tenantId,
            operationKey: prepared.intent.operationKey,
            lotId: prepared.input.outputLotId,
            source: "demo_seed",
            result: actual.linked,
            seed: {
              datasetId: prepared.datasetId,
              recipeVersion: "us-processor-six-month-v1",
              recipeDigest: prepared.input.definitionDigest,
              unitKey: prepared.intent.unitKey,
              intentDigest: canonicalExportDigest(prepared.input),
            },
          },
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
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    }));

  it("rejects a malformed unit for an authorized actor without writes", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            prepared.datasetId,
            "hostile unit key",
            "owned-demo-malformed-unit",
          ),
        ),
      ).rejects.toThrow("us_dataset_unit_invalid");
      expect(await f.snapshot()).toEqual(before);
    }));

  it.each(["tenant", "database", "profile", "header", "unit"] as const)(
    "denies a wrong %s at the new native entry without writes",
    (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision();
        const prepared = await prepareDatasetCasesFixture(f, context, 0);
        if (kind === "profile")
          await f.db
            .update(schema.traceabilityProfiles)
            .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
            .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId));
        const checked =
          kind === "tenant"
            ? { ...context, tenantId: randomUUID() }
            : kind === "database"
              ? { ...context, expectedDatabaseName: "wrong_owned_database" }
              : context;
        const before = await f.snapshot();
        await expect(
          f.db.transaction((tx) =>
            new UsCaseStore(f.db).seedDemoInTransaction(
              tx,
              checked,
              kind === "header" ? randomUUID() : prepared.datasetId,
              kind === "unit" ? "chain_0259" : prepared.intent.unitKey,
              "owned-demo-guard",
            ),
          ),
        ).rejects.toThrow(
          kind === "header"
            ? "us_dataset_conflict"
            : kind === "unit"
              ? "us_dataset_cases_prerequisite_incomplete"
              : "us_dataset_target_invalid",
        );
        expect(await f.snapshot()).toEqual(before);
      }),
  );

  it("refuses a pre-linked supported box without adopting its manual link", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      await f.db.transaction(async (tx) => {
        await insertDatasetCasesFixtureSupport(tx, context, prepared.input);
        await new UsCaseStore(f.db).linkInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          prepared.input.outputLotId,
          { operationKey: randomUUID(), ssccs: [prepared.input.support.boxes[0]?.sscc ?? ""] },
          "owned-demo-manual-link",
        );
      });
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            prepared.datasetId,
            prepared.intent.unitKey,
            "owned-demo-prelinked",
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      expect(await f.snapshot()).toEqual(before);
    }));

  it("refuses an occupied operation key from another native Cases unit", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const first = await prepareDatasetCasesFixture(f, context, 0);
      await f.db.transaction((tx) =>
        new UsCaseStore(f.db).seedDemoInTransaction(
          tx,
          context,
          first.datasetId,
          first.intent.unitKey,
          "owned-demo-first-unit",
        ),
      );
      const second = await prepareDatasetCasesFixture(f, context, 1);
      await f.pool.query(
        "DELETE FROM traceability_demo_dataset_stages WHERE dataset_id=$1 AND unit_key=$2 AND stage='cases'",
        [first.datasetId, first.intent.unitKey],
      );
      await f.pool.query(
        "UPDATE traceability_demo_dataset_stages SET operation_key=$1 WHERE dataset_id=$2 AND unit_key=$3 AND stage='cases'",
        [first.intent.operationKey, second.datasetId, second.intent.unitKey],
      );
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            second.datasetId,
            second.intent.unitKey,
            "owned-demo-key-collision",
          ),
        ),
      ).rejects.toThrow("us_dataset_cases_conflict");
      expect(await f.snapshot()).toEqual(before);
    }));

  it("serializes direct same-key native competitors with one winner and no adoption", () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision();
      const prepared = await prepareDatasetCasesFixture(f, context, 0);
      const entries = await Promise.allSettled([
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            prepared.datasetId,
            prepared.intent.unitKey,
            "owned-demo-competitor-a",
          ),
        ),
        f.db.transaction((tx) =>
          new UsCaseStore(f.db).seedDemoInTransaction(
            tx,
            context,
            prepared.datasetId,
            prepared.intent.unitKey,
            "owned-demo-competitor-b",
          ),
        ),
      ]);
      const winners = entries.filter((entry) => entry.status === "fulfilled");
      const losers = entries.filter((entry) => entry.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ reason: { message: "us_dataset_cases_conflict" } });
      expect(
        await f.db
          .select()
          .from(schema.traceLotBoxOperations)
          .where(eq(schema.traceLotBoxOperations.operationKey, prepared.intent.operationKey)),
      ).toHaveLength(1);
      expect(
        await f.db
          .select()
          .from(schema.traceLotBoxes)
          .where(eq(schema.traceLotBoxes.lotId, prepared.input.outputLotId)),
      ).toHaveLength(55);
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
