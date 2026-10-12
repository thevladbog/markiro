import { describe, expect, it, vi, type TestContext } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { UsDatasetCorrectedCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-cases-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { UsDatasetSpecialChainsSeedStore } from "../src/modules/traceability/demo/us-dataset-special-chains-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { verifyUsDatasetCorrectedShipping } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-verify";
import {
  captureCorrectedShipping,
  correctedShippingStores,
  correctedShippingFault,
  corruptCorrectedShipping,
} from "./support/us-dataset-corrected-shipping-fixture";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { prepareDatasetCorrectedTransformation } from "./support/us-dataset-corrected-transformation-fixture";
import { specialFixture } from "./support/us-dataset-special-fixture";
import {
  outcome,
  driverCode,
  barrier,
  abortable,
  waitBlocked,
  startObservation,
  withOwnedWork,
  ownClient,
} from "./support/us-transformation-lock-fixture";
import {
  prepareCorrectedCases,
  correctedCasesFault,
  corruptCorrectedCases,
} from "./support/us-dataset-corrected-cases-fixture";
import {
  datasetCorrectedTransformationStores,
  corruptCorrectedTransformation,
} from "./support/us-dataset-corrected-transformation-fixture";
import {
  correctedCaseDemoAuditIdentity,
  correctedCaseDemoCommandDigest,
} from "../src/modules/traceability/demo/us-dataset-corrected-cases-result";
import { makeUsDatasetCorrectedCasesInput } from "../src/modules/traceability/demo/us-dataset-corrected-cases-contract";
import { makeUsDatasetReferenceIdentity } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { prepareUsDatasetCorrectedCases } from "../src/modules/traceability/demo/us-dataset-corrected-cases-prepare";
import { verifyUsDatasetCorrectedCases } from "../src/modules/traceability/demo/us-dataset-corrected-cases-verify";
import { insertUsDatasetCasesSupport } from "../src/modules/traceability/demo/us-dataset-cases-support";
import { linkPreparedDemoCasesInTransaction } from "../src/modules/traceability/cases/us-case-demo-content";
import { runCaseLinkCore } from "../src/modules/traceability/cases/us-case-link-core";
import { lockCaseOperation } from "../src/modules/traceability/cases/us-case-operations";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import {
  makeUsDatasetCorrectedShippingInput,
  makeUsDatasetCorrectedShippingPlan,
} from "../src/modules/traceability/demo/us-dataset-corrected-shipping-contract";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Corrected Cases native atomic execution", () => {
  const h = specialFixture(base);
  it(
    "special chains assemble fresh correction and orphan through native Shipping",
    h.phase(async () => {
      const store = new UsDatasetSpecialChainsSeedStore(h.f.db);
      const summary = await store.initialize(h.context);
      expect(
        (
          await h.f.pool.query(
            "SELECT (SELECT count(*)::int FROM traceability_lots) lots, (SELECT count(*)::int FROM boxes) boxes, (SELECT count(*)::int FROM traceability_events WHERE type='shipping' AND status='finalized') shipping",
          )
        ).rows,
      ).toEqual([{ lots: 5, boxes: 60, shipping: 1 }]);
      const special = new UsDatasetSpecialSeedStore(h.f.db);
      const correction = await special.verify(h.context, "correction");
      const orphan = await special.verify(h.context, "orphan");
      expect(correction.stage).toBe("amend_receiving");
      if (correction.stage !== "amend_receiving" || orphan.stage !== "void_receiving")
        throw new Error("Missing native lifecycle results");
      expect(correction.finalized.record.revision).toBe(2);
      expect(correction.predecessor.status).toBe("amended");
      expect(orphan.voided.record.status).toBe("void");
      const transformation = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).verify(
        h.context,
      );
      const cases = await new UsDatasetCorrectedCasesSeedStore(h.f.db).verify(h.context);
      const shipping = await new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context);
      const header = await datasetCorrectedTransformationStores(h.f.db).journal.read(h.context);
      expect(summary).toEqual({
        datasetId: header?.id,
        version: "us-processor-six-month-v1",
        definitionDigest: header?.definitionDigest,
        state: "special_chains_shipping_verified",
        datasetComplete: false,
        correction: {
          unitKey: "correction_0001",
          lifecycleResultDigest: canonicalExportDigest(correction),
          transformationResultDigest: canonicalExportDigest(transformation),
          casesResultDigest: canonicalExportDigest(cases),
          shippingResultDigest: canonicalExportDigest(shipping),
          shipmentCount: 1,
        },
        orphan: { unitKey: "orphan_0001", lifecycleResultDigest: canonicalExportDigest(orphan) },
      });
      expect(Object.isFrozen(summary)).toBe(true);
      expect(Object.isFrozen(summary.correction)).toBe(true);
      expect(Object.isFrozen(summary.orphan)).toBe(true);
      expect(
        await new UsShippingStore(h.f.db).getLotShippingBalance(
          h.context.tenantId,
          h.context.actorUserId,
          shipping.input.casesInput.outputLotId,
          {},
        ),
      ).toMatchObject({
        balance: {
          state: "known",
          unitOfMeasure: "case",
          supply: "60",
          used: "50",
          remaining: "10",
        },
      });
      expect(shipping.outputLotAfter.status).toBe("active");
      const saved = await h.f.snapshot();
      const replay = await store.initialize(h.context);
      const verified = await store.verify(h.context);
      expect(replay).toEqual(summary);
      expect(verified).toEqual(summary);
      expect(replay).not.toBe(summary);
      expect(replay.correction).not.toBe(summary.correction);
      expect(replay.orphan).not.toBe(summary.orphan);
      expect(verified.correction).not.toBe(summary.correction);
      expect(verified.orphan).not.toBe(summary.orphan);
      expect(await h.f.snapshot()).toEqual(saved);
    }),
    60_000,
  );
  it.each(["absent", "references", "amendment", "transformation", "cases", "pending Shipping"])(
    "special chains verify %s without installing or changing any stage",
    h.phase(async (kind) => {
      if (kind !== "absent") await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      if (["amendment", "transformation", "cases", "pending Shipping"].includes(kind))
        await new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, "correction");
      if (["transformation", "cases", "pending Shipping"].includes(kind))
        await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(h.context);
      if (["cases", "pending Shipping"].includes(kind))
        await new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context);
      const pending =
        kind === "pending Shipping" ? await captureCorrectedShipping(h.f, h.context) : null;
      const before = await h.f.snapshot();
      const rejected = await outcome(new UsDatasetSpecialChainsSeedStore(h.f.db).verify(h.context));
      expect(rejected.error instanceof Error && rejected.error.message).toMatch(
        /^us_dataset_.*incomplete$/,
      );
      if (pending) {
        expect(rejected.error).toMatchObject({ unitKey: "correction_0001", stage: "shipping" });
        expect(
          await pending.stores.journal.readStage(
            h.context,
            pending.header.id,
            "correction_0001",
            "shipping",
          ),
        ).toEqual(pending.stage);
      }
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["amended Receiving", "corrected Cases"])(
    "special chains resume after %s and retain upstream receipts",
    h.phase(async (kind) => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      await new UsDatasetSpecialSeedStore(h.f.db).initialize(h.context, "correction");
      if (kind === "corrected Cases") {
        await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(h.context);
        await new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context);
      }
      const journal = datasetCorrectedTransformationStores(h.f.db).journal;
      const header = await journal.read(h.context);
      if (!header) throw new Error("Missing resumed header");
      const amendment = await journal.readStage(
        h.context,
        header.id,
        "correction_0001",
        "amend_receiving",
      );
      const cases = await journal.readStage(h.context, header.id, "correction_0001", "cases");
      const summary = await new UsDatasetSpecialChainsSeedStore(h.f.db).initialize(h.context);
      expect(summary.correction.shipmentCount).toBe(1);
      expect(
        await journal.readStage(h.context, header.id, "correction_0001", "amend_receiving"),
      ).toEqual(amendment);
      if (cases)
        expect(await journal.readStage(h.context, header.id, "correction_0001", "cases")).toEqual(
          cases,
        );
      expect(
        (
          await h.f.pool.query(
            "SELECT count(*)::int n FROM traceability_events WHERE type='shipping'",
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(await new UsDatasetSpecialChainsSeedStore(h.f.db).verify(h.context)).toEqual(summary);
    }),
    60_000,
  );
  it.each(["actual database", "non-owner"])(
    "special chains reject %s before installing references",
    h.phase(async (kind) => {
      const context = {
        ...h.context,
        ...(kind === "actual database"
          ? { expectedDatabaseName: "markiro_us_dev" }
          : { actorUserId: randomUUID() }),
      };
      const before = await h.f.snapshot();
      const store = new UsDatasetSpecialChainsSeedStore(h.f.db);
      await expect(store.initialize(context)).rejects.toThrow("us_dataset_target_invalid");
      await expect(store.verify(context)).rejects.toThrow("us_dataset_target_invalid");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["receipt", "native document"])(
    "special chains reject Shipping %s drift before adding orphan work",
    h.phase(async (kind) => {
      await completed();
      const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      const shipment = result.shipments[0];
      if (!shipment) throw new Error("Missing actual Shipping witness");
      if (kind === "receipt")
        await corruptCorrectedShipping(
          h.f,
          "traceability_demo_dataset_stages",
          "UPDATE traceability_demo_dataset_stages SET receipt=jsonb_set(receipt,'{recordIds}', '[]'::jsonb) WHERE tenant_id=$1 AND unit_key='correction_0001' AND stage='shipping'",
          [h.context.tenantId],
        );
      else
        await corruptCorrectedShipping(
          h.f,
          "reference_documents",
          "UPDATE reference_documents SET notes='Synthetic orchestration drift' WHERE id=$1",
          [shipment.documents[0]?.record.id],
        );
      const before = await h.f.snapshot();
      const store = new UsDatasetSpecialChainsSeedStore(h.f.db);
      for (const run of [() => store.initialize(h.context), () => store.verify(h.context)]) {
        const rejected = await outcome(run());
        expect(rejected.error).toMatchObject({ unitKey: "correction_0001", stage: "shipping" });
        expect(rejected.error instanceof Error && rejected.error.message).toMatch(/^us_dataset_/);
        expect(await h.f.snapshot()).toEqual(before);
      }
      expect(
        (
          await h.f.pool.query(
            "SELECT count(*)::int n FROM traceability_demo_dataset_stages WHERE unit_key='orphan_0001'",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    }),
    60_000,
  );
  it(
    "special chains preserve original Receiving error identity and exact native stage",
    h.phase(async () => {
      await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      const special = new UsDatasetSpecialSeedStore(h.f.db);
      const original = await special.initializeReceiving(h.context, "correction");
      await corruptCorrectedShipping(
        h.f,
        "reference_documents",
        "UPDATE reference_documents SET notes='Synthetic receiving drift' WHERE id=$1",
        [original.documents[0]?.record.id],
      );
      const before = await h.f.snapshot();
      const nativeInitialize = UsDatasetSpecialSeedStore.prototype.initialize;
      let nativeError: unknown;
      const witness = vi
        .spyOn(UsDatasetSpecialSeedStore.prototype, "initialize")
        .mockImplementation(async function (this: UsDatasetSpecialSeedStore, context, kind) {
          try {
            return await nativeInitialize.call(this, context, kind);
          } catch (error) {
            nativeError = error;
            throw error;
          }
        });
      try {
        const rejected = await outcome(
          new UsDatasetSpecialChainsSeedStore(h.f.db).initialize(h.context),
        );
        expect(rejected.error).toBe(nativeError);
        expect(rejected.error).toMatchObject({ unitKey: "correction_0001", stage: "receiving" });
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        witness.mockRestore();
      }
    }),
    60_000,
  );
  it.each(["plain", "frozen", "nonconfigurable", "hostile proxy"])(
    "special chains retain thrown %s object identity when target annotation is unavailable",
    h.phase(async (kind) => {
      const original =
        kind === "plain"
          ? { failure: "synthetic" }
          : kind === "frozen"
            ? Object.freeze(new Error("Synthetic frozen target"))
            : kind === "nonconfigurable"
              ? Object.defineProperty(new Error("Synthetic native target"), "unitKey", {
                  value: "native_unit",
                  configurable: false,
                })
              : new Proxy(new Error("Synthetic hostile target"), {
                  isExtensible() {
                    throw new Error("Synthetic annotation refusal");
                  },
                });
      const before = await h.f.snapshot();
      const witness = vi.spyOn(UsDatasetJournalStore.prototype, "read").mockRejectedValue(original);
      try {
        const rejected = await outcome(
          new UsDatasetSpecialChainsSeedStore(h.f.db).initialize(h.context),
        );
        expect(rejected.error).toBe(original);
        if (kind === "plain")
          expect(rejected.error).toMatchObject({ unitKey: "unknown", stage: "target" });
        if (kind === "nonconfigurable")
          expect(rejected.error).toMatchObject({ unitKey: "native_unit", stage: "target" });
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        witness.mockRestore();
      }
    }),
    60_000,
  );
  const seed = () => new UsDatasetCorrectedCasesSeedStore(h.f.db);
  async function completed() {
    const c = await prepareCorrectedCases(h.f, h.context);
    const result = await seed().initialize(h.context);
    const stage = await c.stores.journal.readStage(
      h.context,
      c.header.id,
      "correction_0001",
      "cases",
    );
    if (!stage?.receipt) throw new Error("Missing completed corrected Cases stage");
    return { ...c, result, stage, receipt: stage.receipt };
  }
  it(
    "completes corrected Shipping with 50 case and unchanged active output, then replays without writes",
    h.phase(async () => {
      await completed();
      const store = new UsDatasetCorrectedShippingSeedStore(h.f.db);
      const response = await outcome(store.initialize(h.context));
      expect(response.error).toBeUndefined();
      const result = response.value;
      if (!result) throw new Error("Missing corrected Shipping result");
      expect(result.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
      expect(result.outputLotAfter).toEqual(result.originLot);
      expect(result.outputLotAfter.status).toBe("active");
      const saved = await h.f.snapshot();
      expect(await store.initialize(h.context)).toEqual(result);
      expect(await store.verify(h.context)).toEqual(result);
      expect(await h.f.snapshot()).toEqual(saved);
    }),
    60_000,
  );
  it(
    "resumes pending corrected Shipping and converges concurrent initializers on one receipt",
    h.phase(async () => {
      await completed();
      const c = await captureCorrectedShipping(h.f, h.context);
      const before = await h.f.snapshot();
      await expect(
        new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context),
      ).rejects.toThrow("us_dataset_corrected_shipping_prerequisite_incomplete");
      expect(await h.f.snapshot()).toEqual(before);
      const results = await Promise.all([
        new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
        new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
      ]);
      expect(results[0]).toEqual(results[1]);
      const stage = await c.stores.journal.readStage(
        h.context,
        c.header.id,
        "correction_0001",
        "shipping",
      );
      expect(stage?.revision).toBe(2);
      expect(stage?.intent).toEqual(c.stage.intent);
      expect(stage?.receipt?.recordIds).toHaveLength(3);
      const balance = await c.stores.shipping.getLotShippingBalance(
        h.context.tenantId,
        h.context.actorUserId,
        c.input.casesInput.outputLotId,
        {},
      );
      expect(balance.balance).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "60",
        used: "50",
        remaining: "10",
      });
    }),
    60_000,
  );
  it(
    "concurrent first corrected Shipping capture keeps one compatible winning intent",
    h.phase(async () => {
      await completed();
      const values = await Promise.all([
        new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
        new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
      ]);
      expect(values[0]).toEqual(values[1]);
      expect(values[0]?.shipments).toHaveLength(1);
    }),
    60_000,
  );
  it.each(["no dataset", "references only", "pending Cases"])(
    "corrected Shipping %s never auto-installs prerequisites",
    h.phase(async (kind) => {
      if (kind === "references only")
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      if (kind === "pending Cases") await prepareCorrectedCases(h.f, h.context);
      const before = await h.f.snapshot();
      const store = new UsDatasetCorrectedShippingSeedStore(h.f.db);
      await expect(store.initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_shipping_prerequisite_incomplete",
      );
      await expect(store.verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_shipping_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["actor", "tenant", "database", "database role", "profile"])(
    "corrected Shipping denies current %s before raw receipt reads or capture",
    h.phase(async (kind) => {
      await completed();
      const c = await captureCorrectedShipping(h.f, h.context);
      if (kind === "profile")
        await h.f.pool.query(
          "UPDATE org_profiles SET time_zone='America/New_York' WHERE tenant_id=$1",
          [h.context.tenantId],
        );
      const context = {
        ...h.context,
        ...(kind === "actor"
          ? { actorUserId: randomUUID() }
          : kind === "tenant"
            ? { tenantId: randomUUID() }
            : kind === "database"
              ? { expectedDatabaseName: "wrong_us_db" }
              : {}),
      };
      const db = kind === "database role" ? await h.f.alternateRole() : h.f.db;
      let touched = false;
      const hostile = {
        get result(): never {
          touched = true;
          throw new Error("raw receipt touched");
        },
        recordIds: [],
        resultDigest: "0".repeat(64),
      };
      const before = await h.f.snapshot();
      await expect(new UsDatasetCorrectedShippingSeedStore(db).initialize(context)).rejects.toThrow(
        "us_dataset_target_invalid",
      );
      await expect(
        db.transaction((tx) =>
          verifyUsDatasetCorrectedShipping(
            tx,
            context,
            c.stage.intent,
            hostile,
            correctedShippingStores(db),
            "replay",
          ),
        ),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(touched).toBe(false);
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["receipt", "operation", "line", "source", "document", "audit", "Cases"] as const)(
    "corrected Shipping rejects persisted %s drift without further changes",
    h.phase(async (kind) => {
      const upstream = await completed();
      const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      const shipment = result.shipments[0];
      if (!shipment) throw new Error("Missing native shipment");
      if (kind === "Cases")
        await corruptCorrectedCases(h.f, "boxes", "UPDATE boxes SET sscc=$2 WHERE id=$1", [
          upstream.input.support.boxes[0]?.id,
          "012345678901234567",
        ]);
      else {
        const changes = {
          receipt: {
            table: "traceability_demo_dataset_stages",
            sql: "UPDATE traceability_demo_dataset_stages SET receipt=jsonb_set(receipt,'{recordIds}', '[]'::jsonb) WHERE tenant_id=$1 AND unit_key='correction_0001' AND stage='shipping'",
            value: h.context.tenantId,
          },
          operation: {
            table: "shipping_operations",
            sql: "UPDATE shipping_operations SET input_digest=repeat('0',64) WHERE event_id=$1",
            value: shipment.created.id,
          },
          line: {
            table: "shipping_event_items",
            sql: "UPDATE shipping_event_items SET quantity=49 WHERE event_id=$1",
            value: shipment.created.id,
          },
          source: {
            table: "shipping_event_items",
            sql: "UPDATE shipping_event_items SET source_snapshot='{}'::jsonb WHERE event_id=$1",
            value: shipment.created.id,
          },
          document: {
            table: "reference_documents",
            sql: "UPDATE reference_documents SET notes='Synthetic drift' WHERE id=$1",
            value: shipment.documents[0]?.record.id,
          },
          audit: {
            table: "tenant_audit_events",
            sql: "UPDATE tenant_audit_events SET request_id='Synthetic drift' WHERE target_id=$1",
            value: shipment.created.id,
          },
        };
        const change = changes[kind];
        await corruptCorrectedShipping(h.f, change.table, change.sql, [change.value]);
      }
      const before = await h.f.snapshot();
      const rejected = await outcome(
        new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context),
      );
      expect(rejected.error).toMatchObject({ unitKey: "correction_0001", stage: "shipping" });
      expect(rejected.error instanceof Error && rejected.error.message).toMatch(/^us_dataset_/);
      await expect(
        new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
      ).rejects.toThrow(/^us_dataset_/);
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["post-finalization verification", "receipt write"])(
    "corrected Shipping %s fault rolls back native writes and leaves resumable intent",
    h.phase(async (kind) => {
      await completed();
      const c = await captureCorrectedShipping(h.f, h.context);
      const before = await h.f.snapshot();
      const remove =
        kind === "receipt write"
          ? await correctedShippingFault(
              h.f,
              "traceability_demo_dataset_stages",
              "UPDATE",
              "NEW.stage='shipping' AND NEW.receipt IS NOT NULL",
              false,
              "23514",
            )
          : await correctedShippingFault(
              h.f,
              "shipping_operations",
              "INSERT",
              "NEW.command='shipping.finalize'",
              true,
              "P0001",
              "ALTER TABLE shipping_event_items DISABLE TRIGGER USER; UPDATE shipping_event_items SET quantity=49 WHERE event_id=NEW.event_id; ALTER TABLE shipping_event_items ENABLE TRIGGER USER;",
            );
      try {
        const rejected = await outcome(
          new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
        );
        if (kind === "receipt write") expect(driverCode(rejected.error)).toBe("23514");
        else
          expect(rejected.error).toMatchObject({
            message: "us_dataset_corrected_shipping_mismatch",
          });
      } finally {
        await remove();
      }
      expect(await h.f.snapshot()).toEqual(before);
      expect(
        (await c.stores.journal.readStage(h.context, c.header.id, "correction_0001", "shipping"))
          ?.receipt,
      ).toBeNull();
      const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      expect(result.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
    }),
    60_000,
  );
  it.each([
    "Shipping amendment",
    "Shipping void",
    "Receiving amendment",
    "Transformation amendment",
  ])(
    "corrected Shipping rejects actual %s current lifecycle drift",
    h.phase(async (kind) => {
      const upstream = await completed();
      const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      const args = {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic lifecycle drift",
      };
      const shipping = new UsShippingStore(h.f.db);
      if (kind === "Shipping amendment" || kind === "Shipping void") {
        const id = result.shipments[0]?.created.id;
        if (!id) throw new Error("Missing shipment");
        await shipping[kind === "Shipping void" ? "void" : "amend"](
          h.context.tenantId,
          h.context.actorUserId,
          id,
          args,
          randomUUID(),
        );
      } else if (kind === "Receiving amendment") {
        await upstream.stores.receiving.amend(
          h.context.tenantId,
          h.context.actorUserId,
          upstream.lifecycle.finalized.eventId,
          { ...args, commandVersion: 2, expectedLifecycleVersion: 4 },
          randomUUID(),
        );
      } else
        await upstream.stores.transformation.amend(
          h.context.tenantId,
          h.context.actorUserId,
          upstream.native.created.id,
          args,
          randomUUID(),
        );
      const before = await h.f.snapshot();
      await expect(
        new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context),
      ).rejects.toThrow("us_dataset_corrected_shipping_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["before application", "after completed"])(
    "corrected Shipping rejects unrelated native consumption %s",
    h.phase(async (kind) => {
      const c = await completed();
      const seedShipping = new UsDatasetCorrectedShippingSeedStore(h.f.db);
      if (kind === "after completed") await seedShipping.initialize(h.context);
      const s = new UsShippingStore(h.f.db);
      const document = await c.stores.documents.createDocument(
        h.context.tenantId,
        h.context.actorUserId,
        {
          type: "bol",
          typeOtherLabel: null,
          number: "Synthetic corrected Shipping unrelated",
          issuedOn: "2026-09-30",
          partyId: null,
          notes: null,
        },
        randomUUID(),
      );
      const draft = await s.createDraft(
        h.context.tenantId,
        h.context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            eventDate: "2026-09-30",
            shipFromLocationId: c.references.bindings.locations.find(
              ({ key }) => key === "processor",
            )?.id,
            recipientLocationId: c.references.bindings.locations.find(
              ({ key }) => key === "recipient",
            )?.id,
            carrierReference: null,
            notes: "Synthetic unrelated",
            items: [{ lotId: c.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
            documentIds: [document.id],
          },
        },
        randomUUID(),
      );
      const ready = await s.checkReadiness(h.context.tenantId, h.context.actorUserId, draft.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      await s.finalize(
        h.context.tenantId,
        h.context.actorUserId,
        draft.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        randomUUID(),
      );
      if (kind === "before application") await captureCorrectedShipping(h.f, h.context);
      const before = await h.f.snapshot();
      await expect(
        kind === "before application"
          ? seedShipping.initialize(h.context)
          : seedShipping.verify(h.context),
      ).rejects.toThrow(
        kind === "before application"
          ? "us_dataset_corrected_shipping_conflict"
          : "us_dataset_corrected_shipping_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it(
    "corrected Shipping refuses a real preexisting recipe document without overwriting it",
    h.phase(async () => {
      const upstream = await completed();
      const c = await captureCorrectedShipping(h.f, h.context);
      const row = makeUsDatasetCorrectedShippingPlan(c.input)[0];
      const definition = c.input.chain.documents.find(
        ({ input }) => input.number === row?.references[0],
      );
      const party = upstream.references.bindings.parties.find(
        ({ key }) => key === definition?.partyKey,
      );
      if (!definition || !party) throw new Error("Missing actual recipe definition/binding");
      await c.stores.documents.createDocument(
        h.context.tenantId,
        h.context.actorUserId,
        { ...definition.input, partyId: party.id },
        randomUUID(),
      );
      const before = await h.f.snapshot();
      await expect(
        new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
      ).rejects.toThrow("us_dataset_corrected_shipping_conflict");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it(
    "corrected Shipping refuses fresh verification of a committed replay receipt",
    h.phase(async () => {
      await completed();
      await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      const stores = correctedShippingStores(h.f.db),
        header = await stores.journal.read(h.context);
      if (!header) throw new Error("Missing actual dataset");
      const stage = await stores.journal.readStage(
        h.context,
        header.id,
        "correction_0001",
        "shipping",
      );
      if (!stage?.receipt) throw new Error("Missing actual receipt");
      const receipt = stage.receipt;
      const before = await h.f.snapshot();
      await expect(
        h.f.db.transaction((tx) =>
          verifyUsDatasetCorrectedShipping(tx, h.context, stage.intent, receipt, stores, "fresh"),
        ),
      ).rejects.toThrow("us_dataset_corrected_shipping_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.for(["Receiving", "Transformation", "Shipping"] as const)(
    "corrected Shipping retains %s root against actual lifecycle writer",
    { timeout: 60_000 },
    h.phase(async (kind, test: TestContext) => {
      const upstream = await completed();
      const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      const stores = correctedShippingStores(h.f.db),
        header = await stores.journal.read(h.context);
      if (!header) throw new Error("Missing actual dataset");
      const stage = await stores.journal.readStage(
        h.context,
        header.id,
        "correction_0001",
        "shipping",
      );
      if (!stage?.receipt) throw new Error("Missing actual Shipping receipt");
      const receipt = stage.receipt;
      const observation = startObservation(test, async (signal, ready) =>
        withOwnedWork(async (own) => {
          if (!base) throw new Error("Missing audited native base");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const reader = createDb(url.toString(), { max: 1, statement_timeout: 8000 }),
            writer = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("reader-pool", () => reader.pool.end());
          own("writer-pool", () => writer.pool.end());
          const readerPid = (
              await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid")
            ).rows[0]?.pid,
            writerPid = (await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
              .rows[0]?.pid;
          if (!readerPid || !writerPid) throw new Error("Missing owned contention PIDs");
          const held = barrier(),
            release = barrier();
          const workers: {
            reading?: ReturnType<typeof outcome>;
            writing?: ReturnType<typeof outcome>;
          } = {};
          own("actual-work-drain", async () => {
            await Promise.allSettled([workers.reading, workers.writing]);
          });
          own("verification-release", async () => {
            release.release();
          });
          workers.reading = outcome(
            reader.db.transaction(async (tx) => {
              await verifyUsDatasetCorrectedShipping(
                tx,
                h.context,
                stage.intent,
                receipt,
                correctedShippingStores(reader.db),
                "replay",
              );
              held.release();
              await release.promise;
            }),
          );
          await abortable(
            Promise.race([
              held.promise,
              workers.reading.then(({ error }) => {
                throw error ?? new Error("Verification ended before gate");
              }),
            ]),
            signal,
          );
          const current = correctedShippingStores(writer.db),
            args = {
              operationKey: randomUUID(),
              expectedLifecycleVersion: 2,
              reason: "Synthetic Shipping lock contention",
            };
          workers.writing = outcome<unknown>(
            kind === "Receiving"
              ? current.receiving.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  upstream.lifecycle.finalized.eventId,
                  { ...args, commandVersion: 2, expectedLifecycleVersion: 4 },
                  randomUUID(),
                )
              : kind === "Transformation"
                ? current.transformation.amend(
                    h.context.tenantId,
                    h.context.actorUserId,
                    upstream.native.created.id,
                    args,
                    randomUUID(),
                  )
                : current.shipping.amend(
                    h.context.tenantId,
                    h.context.actorUserId,
                    result.shipments[0]?.created.id,
                    args,
                    randomUUID(),
                  ),
          );
          await waitBlocked(h.f, readerPid, writerPid, signal);
          await abortable(ready(), signal);
          release.release();
          expect((await workers.reading).error).toBeUndefined();
          expect((await workers.writing).error).toBeUndefined();
        }),
      );
      await observation.ready;
      observation.proceed();
      expect((await observation.running).error).toBeUndefined();
      await observation.cleanup();
      const before = await h.f.snapshot();
      await expect(
        new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context),
      ).rejects.toThrow("us_dataset_corrected_shipping_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );
  it.for(["Receiving", "Transformation", "Shipping"] as const)(
    "corrected Shipping waits for %s root before locking any input/output lot",
    { timeout: 60_000 },
    h.phase(async (kind, test: TestContext) => {
      const upstream = await completed();
      const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
      const stores = correctedShippingStores(h.f.db),
        header = await stores.journal.read(h.context);
      if (!header) throw new Error("Missing actual dataset");
      const stage = await stores.journal.readStage(
        h.context,
        header.id,
        "correction_0001",
        "shipping",
      );
      if (!stage?.receipt) throw new Error("Missing actual Shipping receipt");
      const receipt = stage.receipt;
      const observation = startObservation(test, async (signal, ready) =>
        withOwnedWork(async (own) => {
          if (!base) throw new Error("Missing audited native base");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const reader = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("reader-pool", () => reader.pool.end());
          const readerPid = (
            await reader.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid")
          ).rows[0]?.pid;
          if (!readerPid) throw new Error("Missing owned reader PID");
          const workers: { reading?: ReturnType<typeof outcome> } = {};
          own("actual-work-drain", async () => {
            await Promise.allSettled([workers.reading]);
          });
          const gate = await h.f.pool.connect();
          ownClient(own, gate, "root-gate-release", () => gate.query("ROLLBACK"));
          await gate.query("BEGIN");
          const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]
            ?.pid;
          if (!gatePid) throw new Error("Missing owned gate PID");
          const root =
            kind === "Receiving"
              ? upstream.input.receivingOrigin.rootId
              : kind === "Transformation"
                ? upstream.native.created.id
                : result.shipments[0]?.created.id;
          const table =
            kind === "Receiving"
              ? "receiving_event_roots"
              : kind === "Transformation"
                ? "transformation_event_roots"
                : "shipping_event_roots";
          expect(
            (
              await gate.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [
                h.context.tenantId,
                root,
              ])
            ).rowCount,
          ).toBe(1);
          workers.reading = outcome(
            reader.db.transaction((tx) =>
              verifyUsDatasetCorrectedShipping(
                tx,
                h.context,
                stage.intent,
                receipt,
                correctedShippingStores(reader.db),
                "replay",
              ),
            ),
          );
          await waitBlocked(h.f, gatePid, readerPid, signal);
          await withOwnedWork(async (ownProbe) => {
            const probe = await h.f.pool.connect();
            ownClient(ownProbe, probe, "lot-probe-rollback", () => probe.query("ROLLBACK"));
            await probe.query("BEGIN");
            expect(
              (
                await probe.query(
                  "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
                  [
                    h.context.tenantId,
                    [
                      ...upstream.input.receivingOrigin.inputLots.map(({ lotId }) => lotId),
                      upstream.input.outputLotId,
                    ],
                  ],
                )
              ).rowCount,
            ).toBe(3);
          });
          await abortable(ready(), signal);
          await gate.query("ROLLBACK");
          expect((await workers.reading).error).toBeUndefined();
        }),
      );
      await observation.ready;
      observation.proceed();
      expect((await observation.running).error).toBeUndefined();
      await observation.cleanup();
    }),
  );
  it(
    "binds corrected Shipping input to actual completed corrected Cases evidence without writes",
    h.phase(async () => {
      const c = await completed();
      const before = await h.f.snapshot();
      const response = await outcome(
        Promise.resolve().then(() =>
          makeUsDatasetCorrectedShippingInput(
            makeUsDatasetReferenceIdentity(c.header.id, c.referenceStage),
            c.amendmentStage,
            c.transformation,
            c.stage,
          ),
        ),
      );
      expect(response.error).toBeUndefined();
      const input = response.value;
      if (!input) throw new Error("Missing corrected Shipping input");
      expect(input.cases.operationKey).toBe(c.stage.intent.operationKey);
      expect(input.casesInput.outputLotId).toBe(c.result.input.outputLotId);
      expect(makeUsDatasetCorrectedShippingPlan(input)[0]).toMatchObject({
        quantity: "50",
        unitOfMeasure: "case",
        plannedRemainingAfter: "10",
      });
      expect(input.cases).toEqual({
        datasetId: c.header.id,
        unitKey: "correction_0001",
        stage: "cases",
        revision: 2,
        operationKey: c.stage.intent.operationKey,
        inputDigest: canonicalExportDigest(c.result.input),
        resultDigest: canonicalExportDigest(c.result),
      });
      expect(input.casesInput).toEqual(c.result.input);
      const references = makeUsDatasetReferenceIdentity(c.header.id, c.referenceStage);
      for (const pending of ["cases", "amendment", "transformation"]) {
        const args = structuredClone({
          references,
          amendment: c.amendmentStage,
          transformation: c.transformation,
          cases: c.stage,
        });
        Object.assign(
          args[
            pending === "amendment"
              ? "amendment"
              : pending === "transformation"
                ? "transformation"
                : "cases"
          ],
          { revision: 1, receipt: null },
        );
        expect(() =>
          makeUsDatasetCorrectedShippingInput(
            args.references,
            args.amendment,
            args.transformation,
            args.cases,
          ),
        ).toThrow("us_dataset_corrected_shipping_prerequisite_incomplete");
        expect(await h.f.snapshot()).toEqual(before);
      }
      // Break caught: pending amendment masks support IDs owned by completed Transformation.
      const supportCollisionErrors: unknown[] = [];
      const transformationDocument = c.native.documents[0];
      if (!transformationDocument) throw new Error("Missing actual Transformation document");
      for (const kind of ["shift", "box"]) {
        const args = structuredClone({
          references,
          amendment: c.amendmentStage,
          transformation: c.transformation,
          cases: c.stage,
        });
        const support = structuredClone(c.result.input.support);
        if (kind === "shift") Object.assign(support, { shiftId: transformationDocument.record.id });
        else {
          const box = support.boxes[0];
          if (!box) throw new Error("Missing actual corrected Cases support box");
          Object.assign(box, { id: transformationDocument.record.id });
        }
        Object.assign(args.amendment, { revision: 1, receipt: null });
        Object.assign(args.cases, { revision: 1, receipt: null });
        Object.assign(args.cases.intent.input, { support });
        Object.assign(args.cases.intent, {
          inputDigest: canonicalExportDigest(args.cases.intent.input),
        });
        const rejected = await outcome(
          Promise.resolve().then(() =>
            makeUsDatasetCorrectedShippingInput(
              args.references,
              args.amendment,
              args.transformation,
              args.cases,
            ),
          ),
        );
        supportCollisionErrors.push(rejected.error);
        expect(await h.f.snapshot()).toEqual(before);
      }
      expect(
        supportCollisionErrors.map((error) => (error instanceof Error ? error.message : undefined)),
      ).toEqual([
        "us_dataset_corrected_shipping_dependency_conflict",
        "us_dataset_corrected_shipping_dependency_conflict",
      ]);
      for (const error of supportCollisionErrors) {
        expect(error).toMatchObject({ unitKey: "correction_0001", stage: "shipping" });
        expect(error instanceof Error && error.cause).toBeTruthy();
      }
      // Break caught: receipt/input/key/request/ordered ownership evidence accepted after forgery.
      for (const kind of [
        "stage extra",
        "stage name",
        "missing stage",
        "pending malformed",
        "pending forged key",
        "completed null",
        "revision contradiction",
        "intent key",
        "intent digest",
        "result digest",
        "record count",
        "record order",
        "record duplicate",
        "record foreign",
        "request",
        "result key",
        "result input",
        "upstream references",
        "upstream amendment",
        "upstream transformation",
        "pending upstream contradictory cases",
        "pending amendment contradictory references",
        "pending amendment contradictory transformation",
        "pending transformation contradictory amendment",
        "pending transformation contradictory cases",
      ]) {
        const args = structuredClone({
          references,
          amendment: c.amendmentStage,
          transformation: c.transformation,
          cases: c.stage,
        });
        const row = args.cases,
          receipt = row.receipt;
        if (!receipt) throw new Error("Missing real Cases witness receipt");
        switch (kind) {
          case "stage extra":
            Object.assign(row, { extra: true });
            break;
          case "stage name":
            Object.assign(row, { stage: "shipping" });
            break;
          case "missing stage":
            Object.assign(row, { intent: null });
            break;
          case "pending malformed":
            Object.assign(row, { revision: 1, receipt: null, intent: null });
            break;
          case "pending forged key":
            Object.assign(row, { revision: 1, receipt: null });
            Object.assign(row.intent, { unitKey: "chain_0001" });
            break;
          case "completed null":
            Object.assign(row, { receipt: null });
            break;
          case "revision contradiction":
            Object.assign(row, { revision: 1 });
            break;
          case "intent key":
            Object.assign(row.intent, { operationKey: randomUUID() });
            break;
          case "intent digest":
            Object.assign(row.intent, { inputDigest: "0".repeat(64) });
            break;
          case "result digest":
            Object.assign(receipt, { resultDigest: "0".repeat(64) });
            break;
          case "record count":
            Object.assign(receipt, { recordIds: receipt.recordIds.slice(1) });
            break;
          case "record order":
            Object.assign(receipt, { recordIds: [...receipt.recordIds].reverse() });
            break;
          case "record duplicate":
            Object.assign(receipt, {
              recordIds: receipt.recordIds.map(() => c.result.support.shift.id),
            });
            break;
          case "record foreign":
            Object.assign(receipt, { recordIds: [randomUUID(), ...receipt.recordIds.slice(1)] });
            break;
          case "request":
            Object.assign(receipt.result, { requestId: "forged-request" });
            Object.assign(receipt, { resultDigest: canonicalExportDigest(receipt.result) });
            break;
          case "result key":
            Object.assign(receipt.result, { operationKey: randomUUID() });
            Object.assign(receipt, { resultDigest: canonicalExportDigest(receipt.result) });
            break;
          case "result input":
            Object.assign(receipt.result, {
              input: { ...c.result.input, outputLotId: randomUUID() },
            });
            Object.assign(receipt, { resultDigest: canonicalExportDigest(receipt.result) });
            break;
          case "upstream references":
            Object.assign(args.references, { resultDigest: "0".repeat(64) });
            break;
          case "upstream amendment":
            Object.assign(args.amendment.intent, { operationKey: randomUUID() });
            break;
          case "upstream transformation":
            Object.assign(args.transformation.intent, { operationKey: randomUUID() });
            break;
          case "pending upstream contradictory cases":
            Object.assign(args.amendment, { revision: 1, receipt: null });
            Object.assign(row.intent, { operationKey: randomUUID() });
            break;
          case "pending amendment contradictory references":
            Object.assign(args.amendment, { revision: 1, receipt: null });
            Object.assign(args.references, { operationKey: randomUUID() });
            Object.assign(args.amendment.intent.input, { references: args.references });
            Object.assign(args.amendment.intent, {
              inputDigest: canonicalExportDigest(args.amendment.intent.input),
            });
            break;
          case "pending amendment contradictory transformation":
            Object.assign(args.amendment, { revision: 1, receipt: null });
            Object.assign(args.transformation.intent, { operationKey: randomUUID() });
            break;
          case "pending transformation contradictory amendment":
            Object.assign(args.transformation, { revision: 1, receipt: null });
            Object.assign(args.amendment.intent, { operationKey: randomUUID() });
            break;
          case "pending transformation contradictory cases":
            Object.assign(args.transformation, { revision: 1, receipt: null });
            Object.assign(row.intent, { operationKey: randomUUID() });
            break;
        }
        const rejected = await outcome(
          Promise.resolve().then(() =>
            makeUsDatasetCorrectedShippingInput(
              args.references,
              args.amendment,
              args.transformation,
              args.cases,
            ),
          ),
        );
        expect(rejected.error, kind).toMatchObject({
          message: "us_dataset_corrected_shipping_dependency_conflict",
          unitKey: "correction_0001",
          stage: "shipping",
        });
        expect(rejected.error instanceof Error && rejected.error.cause, kind).toBeTruthy();
        expect(await h.f.snapshot()).toEqual(before);
      }
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );
  it(
    "creates 60 actual corrected links and completes its owned journal receipt",
    h.phase(async () => {
      const c = await prepareDatasetCorrectedTransformation(h.f.db, h.context);
      const transformation = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(
        h.context,
      );
      const beforeDependencies = (
        await h.f.pool.query<{ id: string; current_dependency_version: number }>(
          "SELECT id,current_dependency_version FROM traceability_lots ORDER BY id",
        )
      ).rows;
      const beforeEvents = (
        await h.f.pool.query("SELECT to_jsonb(t) row FROM traceability_events t ORDER BY id")
      ).rows;
      const response = await outcome(
        new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context),
      );
      expect(response.error).toBeUndefined();
      const result = response.value;
      if (!result) throw new Error("Missing corrected Cases result");
      expect(result.linked.created).toHaveLength(60);
      expect(result.input.outputLotId).toBe(transformation.outputLot.id);
      expect(result.input.support.numberSeq).toBe(261);
      expect(
        (
          await h.f.pool.query(
            "SELECT (SELECT count(*)::int FROM boxes) boxes,(SELECT count(*)::int FROM trace_lot_boxes) links,(SELECT count(*)::int FROM traceability_synthetic_case_origins) markers",
          )
        ).rows,
      ).toEqual([{ boxes: 60, links: 60, markers: 60 }]);
      const stage = await c.stores.journal.readStage(
        h.context,
        c.header.id,
        "correction_0001",
        "cases",
      );
      expect(stage?.revision).toBe(2);
      expect(stage?.receipt?.resultDigest).toBe(canonicalExportDigest(result));
      expect(stage?.receipt?.recordIds).toHaveLength(121);
      expect(stage?.receipt?.recordIds).toEqual([
        result.support.shift.id,
        ...result.support.boxes.map(({ id }) => id),
        ...result.linked.created.map(({ linkId }) => linkId),
      ]);
      expect(
        (
          await h.f.pool.query(
            "SELECT id,current_dependency_version FROM traceability_lots ORDER BY id",
          )
        ).rows,
      ).toEqual(
        beforeDependencies.map((row) => ({
          ...row,
          current_dependency_version:
            row.current_dependency_version + (row.id === transformation.outputLot.id ? 1 : 0),
        })),
      );
      expect(
        (await h.f.pool.query("SELECT to_jsonb(t) row FROM traceability_events t ORDER BY id"))
          .rows,
      ).toEqual(beforeEvents);
      const beforeReplay = await h.f.snapshot();
      expect(await new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context)).toEqual(
        result,
      );
      expect(await new UsDatasetCorrectedCasesSeedStore(h.f.db).verify(h.context)).toEqual(result);
      expect(await h.f.snapshot()).toEqual(beforeReplay);
    }),
    30000,
  );
  it(
    "preserves exact actor, seed provenance, native digest and zero physical facts",
    h.phase(async () => {
      const c = await completed(),
        r = c.result;
      expect(r.linked.unchanged).toEqual([]);
      expect(
        r.linked.created.every(
          (link) =>
            link.linkedBy === h.context.actorUserId &&
            link.linkSource === "demo_seed" &&
            link.provenance === "synthetic_demo" &&
            link.originState === "current" &&
            link.ssccState === "consistent" &&
            link.unlinkedAt === null,
        ),
      ).toBe(true);
      expect(
        (
          await h.f.pool.query(
            "SELECT tenant_id,command,operation_key,input_digest,target_id,result FROM trace_lot_box_operations",
          )
        ).rows,
      ).toEqual([
        {
          tenant_id: h.context.tenantId,
          command: "case.link",
          operation_key: r.operationKey,
          input_digest: correctedCaseDemoCommandDigest(r.input),
          target_id: r.input.outputLotId,
          result: r.linked,
        },
      ]);
      expect(
        (
          await h.f.pool.query(
            "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE request_id=$1",
            [r.requestId],
          )
        ).rows,
      ).toEqual([
        {
          organization_id: h.context.tenantId,
          actor_user_id: h.context.actorUserId,
          action: "case.link",
          outcome: "success",
          target_type: "traceability_lot",
          target_id: r.input.outputLotId,
          before: { links: [] },
          after: {
            tenantId: h.context.tenantId,
            operationKey: r.operationKey,
            lotId: r.input.outputLotId,
            source: "demo_seed",
            result: r.linked,
            seed: {
              datasetId: c.header.id,
              recipeVersion: "us-processor-six-month-v1",
              recipeDigest: r.input.definitionDigest,
              unitKey: "correction_0001",
              intentDigest: canonicalExportDigest(r.input),
            },
          },
          request_id: r.requestId,
        },
      ]);
      expect(
        (
          await h.f.pool.query(
            "SELECT (SELECT count(*)::int FROM box_items) items,(SELECT count(*)::int FROM scan_events) scans,(SELECT count(*)::int FROM station_shift_close_events) closures,(SELECT count(*)::int FROM shift_device_participants) participants",
          )
        ).rows,
      ).toEqual([{ items: 0, scans: 0, closures: 0, participants: 0 }]);
      expect(c.native.finalized.snapshot.inputs.map(({ quantity }) => quantity)).toEqual([
        "300",
        "400",
      ]);
      expect(c.original.finalized.record.content.kind).toBe("finalized");
      if (c.original.finalized.record.content.kind !== "finalized")
        throw new Error("Missing original Receiving snapshot");
      expect(
        c.original.finalized.record.content.snapshot.items.map(({ quantity }) => quantity),
      ).toEqual(["250", "400"]);
    }),
    30000,
  );

  it.each(["missing dataset", "references only", "no capture", "pending"])(
    "verify never captures or installs %s",
    h.phase(async (kind) => {
      if (kind === "references only")
        await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
      if (kind === "no capture" || kind === "pending")
        await prepareCorrectedCases(h.f, h.context, kind === "pending");
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_cases_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it.each([
    ["boxes", "INSERT", "true"],
    ["traceability_synthetic_case_origins", "INSERT", "true"],
    ["trace_lot_boxes", "INSERT", "(SELECT count(*) FROM trace_lot_boxes)>0"],
    ["tenant_audit_events", "INSERT", "NEW.action='case.link'"],
    ["trace_lot_box_operations", "INSERT", "true"],
    [
      "traceability_demo_dataset_stages",
      "UPDATE",
      "NEW.unit_key='correction_0001' AND NEW.stage='cases' AND NEW.receipt IS NOT NULL",
    ],
  ] as const)(
    "rolls back actual writes at %s while retaining exact captured intent",
    h.phase(async (table, action, condition) => {
      const c = await prepareCorrectedCases(h.f, h.context),
        before = await h.f.snapshot();
      const remove = await correctedCasesFault(h.f, table, action, condition);
      try {
        const failed = await outcome(seed().initialize(h.context));
        expect(driverCode(failed.error)).toBe("P0001");
        expect(failed.error).toMatchObject({ unitKey: "correction_0001", stage: "cases" });
        expect(await h.f.snapshot()).toEqual(before);
        expect(
          await c.stores.journal.readStage(h.context, c.header.id, "correction_0001", "cases"),
        ).toEqual(c.stage);
      } finally {
        await remove();
      }
      const result = await seed().initialize(h.context);
      expect(result.input).toEqual(c.input);
      expect(result.operationKey).toBe(c.intent.operationKey);
      expect(result.linked.created).toHaveLength(60);
    }),
    30000,
  );

  it(
    "mandatory candidate content proof rolls back drift introduced after native operations",
    h.phase(async () => {
      await prepareCorrectedCases(h.f, h.context);
      const before = await h.f.snapshot(),
        remove = await correctedCasesFault(h.f, "trace_lot_box_operations", "INSERT", "true", true);
      try {
        await expect(seed().initialize(h.context)).rejects.toThrow(
          "us_dataset_corrected_cases_mismatch",
        );
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        await remove();
      }
      expect((await seed().initialize(h.context)).linked.created).toHaveLength(60);
    }),
    30000,
  );

  it.each(["demo_seed", "manual"] as const)(
    "never adopts a real pending %s native operation",
    h.phase(async (source) => {
      const c = await prepareCorrectedCases(h.f, h.context);
      await h.f.db.transaction(async (tx) => {
        await prepareUsDatasetCorrectedCases(
          tx,
          h.context,
          c.intent,
          { mode: "application" },
          c.stores,
        );
        await insertUsDatasetCasesSupport(tx, h.context, c.input);
        if (source === "manual")
          await runCaseLinkCore(
            tx,
            h.context.tenantId,
            h.context.actorUserId,
            c.input.outputLotId,
            {
              operationKey: c.intent.operationKey,
              ssccs: c.input.support.boxes.map(({ sscc }) => sscc),
            },
            "manual-pending",
            "manual",
          );
        else
          await linkPreparedDemoCasesInTransaction(
            tx,
            h.context,
            c.input,
            c.intent.operationKey,
            `dataset-cases:${c.intent.operationKey}`,
            {
              digest: correctedCaseDemoCommandDigest(c.input),
              seed: correctedCaseDemoAuditIdentity(c.input),
            },
            null,
            () => new Error("native_fixture_conflict"),
          );
      });
      expect((await h.f.pool.query("SELECT count(*)::int n FROM trace_lot_boxes")).rows).toEqual([
        { n: 60 },
      ]);
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_cases_conflict",
      );
      await expect(seed().verify(h.context)).rejects.toThrow(
        "us_dataset_corrected_cases_prerequisite_incomplete",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "rejects captured support aliasing an actual prerequisite document ID",
    h.phase(async () => {
      const c = await prepareCorrectedCases(h.f, h.context, false);
      const document = c.original.documents[0]?.record.id;
      if (!document) throw new Error("Missing actual Receiving document");
      const input = makeUsDatasetCorrectedCasesInput(
        makeUsDatasetReferenceIdentity(c.header.id, c.referenceStage),
        c.amendmentStage,
        c.transformation,
        { ...c.input.support, shiftId: document },
      );
      const intent = { ...c.intent, input, inputDigest: canonicalExportDigest(input) };
      await c.stores.journal.captureIntent(h.context, c.header.id, intent);
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_cases_conflict",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "rejects a native generated link ID aliasing a Receiving document and rolls back all writes",
    h.phase(async () => {
      const c = await prepareCorrectedCases(h.f, h.context),
        document = c.original.documents[0]?.record.id;
      if (!document) throw new Error("Missing actual prerequisite document");
      const before = await h.f.snapshot();
      const remove = await correctedCasesFault(
        h.f,
        "trace_lot_boxes",
        "INSERT",
        "(SELECT count(*) FROM trace_lot_boxes)=0",
        false,
        "P0001",
        `NEW.id='${document}'::uuid;`,
      );
      try {
        await expect(seed().initialize(h.context)).rejects.toThrow(
          "us_dataset_corrected_cases_mismatch",
        );
        expect(await h.f.snapshot()).toEqual(before);
      } finally {
        await remove();
      }
    }),
    30000,
  );

  it(
    "allows operation-key UUIDs from their separate namespace",
    h.phase(async () => {
      const c = await prepareCorrectedCases(h.f, h.context, false),
        operationKey = c.original.documents[0]?.record.id;
      if (!operationKey) throw new Error("Missing actual prerequisite document");
      await c.stores.journal.captureIntent(h.context, c.header.id, { ...c.intent, operationKey });
      const result = await seed().initialize(h.context);
      expect(result.operationKey).toBe(operationKey);
      expect(result.linked.created).toHaveLength(60);
    }),
    30000,
  );

  it(
    "never adopts fresh support committed outside its own apply",
    h.phase(async () => {
      const c = await prepareCorrectedCases(h.f, h.context);
      await h.f.db.transaction(async (tx) => {
        await prepareUsDatasetCorrectedCases(
          tx,
          h.context,
          c.intent,
          { mode: "application" },
          c.stores,
        );
        await insertUsDatasetCasesSupport(tx, h.context, c.input);
      });
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_cases_conflict",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "resolves a simulated lost commit acknowledgement by read-only receipt/current proof",
    h.phase(async () => {
      const c = await prepareCorrectedCases(h.f, h.context);
      const acknowledgement = await outcome(
        seed()
          .initialize(h.context)
          .then(() => {
            throw new Error("simulated_lost_commit_acknowledgement");
          }),
      );
      expect(acknowledgement.error).toMatchObject({
        message: "simulated_lost_commit_acknowledgement",
      });
      const before = await h.f.snapshot();
      const result = await seed().verify(h.context);
      expect(result.input).toEqual(c.input);
      expect(result.operationKey).toBe(c.intent.operationKey);
      expect(await seed().initialize(h.context)).toEqual(result);
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it.each(["foreign actor", "foreign tenant", "wrong database", "wrong database role"])(
    "denies %s before touching raw getter evidence",
    h.phase(async (kind) => {
      const c = await completed();
      let touched = false;
      const poisoned = { ...c.stage.intent };
      Object.defineProperty(poisoned, "input", {
        get() {
          touched = true;
          throw new Error("raw_evidence_touched");
        },
      });
      const context = {
        ...h.context,
        ...(kind === "foreign actor"
          ? { actorUserId: randomUUID() }
          : kind === "foreign tenant"
            ? { tenantId: randomUUID() }
            : kind === "wrong database"
              ? { expectedDatabaseName: "wrong_us_database" }
              : {}),
      };
      const db = kind === "wrong database role" ? await h.f.alternateRole() : h.f.db;
      const before = await h.f.snapshot();
      await expect(
        db.transaction((tx) =>
          verifyUsDatasetCorrectedCases(
            tx,
            context,
            poisoned,
            c.receipt,
            "replay",
            datasetCorrectedTransformationStores(db),
          ),
        ),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(touched).toBe(false);
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "revalidates current membership before returning completed evidence",
    h.phase(async () => {
      await completed();
      await h.f.pool.query(
        "UPDATE member SET role='member' WHERE user_id=$1 AND organization_id=$2",
        [h.context.actorUserId, h.context.tenantId],
      );
      const before = await h.f.snapshot();
      await expect(seed().initialize(h.context)).rejects.toThrow("us_dataset_target_invalid");
      await expect(seed().verify(h.context)).rejects.toThrow("us_dataset_target_invalid");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it.each([
    ["shifts", "UPDATE shifts SET planned_qty=1 WHERE id=$1"],
    ["boxes", "UPDATE boxes SET print_verified_at=now() WHERE id=$1"],
    [
      "traceability_synthetic_case_origins",
      "UPDATE traceability_synthetic_case_origins SET seed_version=2 WHERE box_id=$1",
    ],
    ["trace_lot_boxes", "UPDATE trace_lot_boxes SET linked_by=$2 WHERE box_id=$1"],
    [
      "trace_lot_box_operations",
      "UPDATE trace_lot_box_operations SET input_digest=repeat('0',64) WHERE operation_key=$1",
    ],
    [
      "tenant_audit_events",
      "UPDATE tenant_audit_events SET before='{}'::jsonb WHERE request_id=$1",
    ],
  ] as const)(
    "rejects %s saved/current drift without repair",
    h.phase(async (table, query) => {
      const c = await completed();
      const id =
        table === "shifts"
          ? c.input.support.shiftId
          : table === "trace_lot_box_operations"
            ? c.intent.operationKey
            : table === "tenant_audit_events"
              ? c.result.requestId
              : c.input.support.boxes[0]?.id;
      await corruptCorrectedCases(
        h.f,
        table,
        query,
        table === "trace_lot_boxes" ? [id, randomUUID()] : [id],
      );
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow("us_dataset_corrected_cases_mismatch");
      await expect(seed().initialize(h.context)).rejects.toThrow(
        "us_dataset_corrected_cases_mismatch",
      );
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "rejects unlink/relink history and keeps the drift visible",
    h.phase(async () => {
      const c = await completed(),
        link = c.result.linked.created[0];
      if (!link) throw new Error("Missing corrected case");
      const cases = new UsCaseStore(h.f.db);
      await cases.unlink(
        h.context.tenantId,
        h.context.actorUserId,
        c.input.outputLotId,
        link.linkId,
        { operationKey: randomUUID(), reason: "Synthetic drift" },
        "unlink-drift",
      );
      await cases.link(
        h.context.tenantId,
        h.context.actorUserId,
        c.input.outputLotId,
        { operationKey: randomUUID(), ssccs: [link.ssccAtLink] },
        "relink-drift",
      );
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow("us_dataset_corrected_cases_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it.each([
    "archive",
    "Transformation amendment",
    "Transformation void",
    "Receiving amendment",
    "document drift",
  ])(
    "rejects current %s origin drift without repair",
    h.phase(async (kind) => {
      const c = await completed();
      if (kind === "archive")
        await c.stores.lots.changeStatus(
          h.context.tenantId,
          h.context.actorUserId,
          c.input.outputLotId,
          { status: "archived", expectedRevision: 1, reason: "Synthetic drift" },
          randomUUID(),
        );
      else if (kind === "Receiving amendment")
        await c.stores.receiving.amend(
          h.context.tenantId,
          h.context.actorUserId,
          c.lifecycle.finalized.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: 4,
            reason: "Synthetic drift",
          },
          randomUUID(),
        );
      else if (kind === "document drift")
        await corruptCorrectedTransformation(
          h.f,
          "reference_documents",
          "UPDATE reference_documents SET notes='Synthetic drift' WHERE id=$1",
          [c.native.documents[0]?.record.id],
        );
      else
        await c.stores.transformation[kind === "Transformation void" ? "void" : "amend"](
          h.context.tenantId,
          h.context.actorUserId,
          c.native.created.id,
          { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Synthetic drift" },
          randomUUID(),
        );
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow("us_dataset_corrected_cases_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "accepts later real Shipping consumption while preserving immutable Cases receipt",
    h.phase(async () => {
      const c = await completed(),
        s = new UsShippingStore(h.f.db),
        refs = c.references.bindings;
      const document = await c.stores.documents.createDocument(
        h.context.tenantId,
        h.context.actorUserId,
        {
          type: "bol",
          typeOtherLabel: null,
          number: "Synthetic-corrected-Cases-shipping",
          issuedOn: "2026-09-30",
          partyId: null,
          notes: null,
        },
        randomUUID(),
      );
      const draft = await s.createDraft(
        h.context.tenantId,
        h.context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            eventDate: "2026-09-30",
            shipFromLocationId: refs.locations.find((x) => x.key === "processor")?.id,
            recipientLocationId: refs.locations.find((x) => x.key === "recipient")?.id,
            carrierReference: null,
            notes: "Synthetic downstream",
            items: [{ lotId: c.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
            documentIds: [document.id],
          },
        },
        randomUUID(),
      );
      const ready = await s.checkReadiness(h.context.tenantId, h.context.actorUserId, draft.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      await s.finalize(
        h.context.tenantId,
        h.context.actorUserId,
        draft.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        randomUUID(),
      );
      const balance = await s.getLotShippingBalance(
        h.context.tenantId,
        h.context.actorUserId,
        c.input.outputLotId,
        {},
      );
      expect(balance.balance).toMatchObject({
        state: "known",
        supply: "60",
        used: "1",
        remaining: "59",
      });
      const before = await h.f.snapshot();
      expect(await seed().verify(h.context)).toEqual(c.result);
      expect(await seed().initialize(h.context)).toEqual(c.result);
      expect(await h.f.snapshot()).toEqual(before);
    }),
    30000,
  );

  it(
    "concurrent first capture adopts exactly the winning support and one operation",
    h.phase(async () => {
      await prepareCorrectedCases(h.f, h.context, false);
      const responses = await Promise.allSettled([
        seed().initialize(h.context),
        seed().initialize(h.context),
      ]);
      expect(responses.every((r) => r.status === "fulfilled")).toBe(true);
      const first = responses[0],
        second = responses[1];
      if (first?.status !== "fulfilled" || second?.status !== "fulfilled")
        throw new Error("Concurrent corrected capture failed");
      expect(first.value).toEqual(second.value);
      expect(
        (
          await h.f.pool.query(
            "SELECT (SELECT count(*)::int FROM shifts) shifts,(SELECT count(*)::int FROM boxes) boxes,(SELECT count(*)::int FROM trace_lot_boxes) links,(SELECT count(*)::int FROM trace_lot_box_operations) operations",
          )
        ).rows,
      ).toEqual([{ shifts: 1, boxes: 60, links: 60, operations: 1 }]);
    }),
    30000,
  );

  it(
    "waits for the Cases operation holder before acquiring either origin, lots or boxes",
    h.phase(async (test: TestContext) => {
      const c = await completed();
      const observation = startObservation(test, async (signal, ready) =>
        withOwnedWork(async (own) => {
          if (!base) throw new Error("Missing native base");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const replay = createDb(url.toString(), { max: 1, statement_timeout: 8000 }),
            holder = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("replay-pool", () => replay.pool.end());
          own("holder-pool", () => holder.pool.end());
          const replayPid = (
              await replay.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid")
            ).rows[0]?.pid,
            holderPid = (await holder.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
              .rows[0]?.pid;
          if (!replayPid || !holderPid) throw new Error("Missing operation contention PID");
          const held = barrier(),
            release = barrier();
          const workers: {
            reader?: ReturnType<typeof outcome>;
            writer?: ReturnType<typeof outcome>;
          } = {};
          own("actual-workers-drain", async () => {
            await Promise.allSettled([workers.reader, workers.writer]);
          });
          own("operation-holder-release", async () => {
            release.release();
          });
          workers.writer = outcome(
            holder.db.transaction(async (tx) => {
              await lockCaseOperation(tx, h.context.tenantId, "case.link", c.intent.operationKey);
              held.release();
              await release.promise;
            }),
          );
          await abortable(
            Promise.race([
              held.promise,
              workers.writer.then(({ error }) => {
                throw error ?? new Error("Operation holder ended early");
              }),
            ]),
            signal,
          );
          workers.reader = outcome(
            replay.db.transaction((tx) =>
              verifyUsDatasetCorrectedCases(
                tx,
                h.context,
                c.intent,
                c.receipt,
                "replay",
                datasetCorrectedTransformationStores(replay.db),
              ),
            ),
          );
          await waitBlocked(h.f, holderPid, replayPid, signal);
          await withOwnedWork(async (ownProbe) => {
            const probe = await h.f.pool.connect();
            ownClient(ownProbe, probe, "probe-rollback", () => probe.query("ROLLBACK"));
            await probe.query("BEGIN");
            expect(
              (
                await probe.query(
                  "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
                  [h.context.tenantId, c.original.created.eventId],
                )
              ).rowCount,
            ).toBe(1);
            expect(
              (
                await probe.query(
                  "SELECT id FROM transformation_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
                  [h.context.tenantId, c.native.created.id],
                )
              ).rowCount,
            ).toBe(1);
            expect(
              (
                await probe.query(
                  "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
                  [
                    h.context.tenantId,
                    [
                      ...c.input.receivingOrigin.inputLots.map(({ lotId }) => lotId),
                      c.input.outputLotId,
                    ],
                  ],
                )
              ).rowCount,
            ).toBe(3);
            expect(
              (
                await probe.query(
                  "SELECT id FROM boxes WHERE tenant_id=$1 ORDER BY sscc,id FOR UPDATE NOWAIT",
                  [h.context.tenantId],
                )
              ).rowCount,
            ).toBe(60);
          });
          await abortable(ready(), signal);
          release.release();
          expect((await workers.reader).error).toBeUndefined();
          expect((await workers.writer).error).toBeUndefined();
        }),
      );
      await observation.ready;
      observation.proceed();
      expect((await observation.running).error).toBeUndefined();
      await observation.cleanup();
    }),
    30000,
  );

  it.for(["Receiving", "Transformation"] as const)(
    "holds %s lifecycle roots throughout corrected current verification",
    { timeout: 30000 },
    h.phase(async (kind, test: TestContext) => {
      const c = await completed();
      const observation = startObservation(test, async (signal, ready) =>
        withOwnedWork(async (own) => {
          if (!base) throw new Error("Missing native base");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const replay = createDb(url.toString(), { max: 1, statement_timeout: 8000 }),
            writer = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("replay-pool", () => replay.pool.end());
          own("writer-pool", () => writer.pool.end());
          const replayPid = (
              await replay.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid")
            ).rows[0]?.pid,
            writerPid = (await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
              .rows[0]?.pid;
          if (!replayPid || !writerPid) throw new Error("Missing lifecycle contention PID");
          const held = barrier(),
            release = barrier();
          const workers: {
            reader?: ReturnType<typeof outcome>;
            writing?: ReturnType<typeof outcome>;
          } = {};
          own("actual-workers-drain", async () => {
            await Promise.allSettled([workers.reader, workers.writing]);
          });
          own("verification-release", async () => {
            release.release();
          });
          workers.reader = outcome(
            replay.db.transaction(async (tx) => {
              await verifyUsDatasetCorrectedCases(
                tx,
                h.context,
                c.intent,
                c.receipt,
                "replay",
                datasetCorrectedTransformationStores(replay.db),
              );
              held.release();
              await release.promise;
            }),
          );
          await abortable(
            Promise.race([
              held.promise,
              workers.reader.then(({ error }) => {
                throw error ?? new Error("Verifier ended before gate");
              }),
            ]),
            signal,
          );
          const stores = datasetCorrectedTransformationStores(writer.db),
            args = { operationKey: randomUUID(), reason: "Synthetic actual lifecycle contention" };
          workers.writing = outcome<unknown>(
            kind === "Receiving"
              ? stores.receiving.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  c.lifecycle.finalized.eventId,
                  { ...args, commandVersion: 2, expectedLifecycleVersion: 4 },
                  randomUUID(),
                )
              : stores.transformation.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  c.native.created.id,
                  { ...args, expectedLifecycleVersion: 2 },
                  randomUUID(),
                ),
          );
          await waitBlocked(h.f, replayPid, writerPid, signal);
          await abortable(ready(), signal);
          release.release();
          expect((await workers.reader).error).toBeUndefined();
          expect((await workers.writing).error).toBeUndefined();
        }),
      );
      await observation.ready;
      observation.proceed();
      expect((await observation.running).error).toBeUndefined();
      await observation.cleanup();
      const before = await h.f.snapshot();
      await expect(seed().verify(h.context)).rejects.toThrow("us_dataset_corrected_cases_mismatch");
      expect(await h.f.snapshot()).toEqual(before);
    }),
  );

  it.for(["Receiving", "Transformation"] as const)(
    "waits for %s root holder before taking any input/output lot lock",
    { timeout: 30000 },
    h.phase(async (kind, test: TestContext) => {
      const c = await completed();
      const observation = startObservation(test, async (signal, ready) =>
        withOwnedWork(async (own) => {
          if (!base) throw new Error("Missing native base");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const replay = createDb(url.toString(), { max: 1, statement_timeout: 8000 }),
            writer = createDb(url.toString(), { max: 1, statement_timeout: 8000 });
          own("replay-pool", () => replay.pool.end());
          own("writer-pool", () => writer.pool.end());
          const replayPid = (
              await replay.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid")
            ).rows[0]?.pid,
            writerPid = (await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
              .rows[0]?.pid;
          if (!replayPid || !writerPid) throw new Error("Missing root contention PID");
          const workers: {
            reader?: ReturnType<typeof outcome>;
            writing?: ReturnType<typeof outcome>;
          } = {};
          own("actual-workers-drain", async () => {
            await Promise.allSettled([workers.reader, workers.writing]);
          });
          const gate = await h.f.pool.connect();
          ownClient(own, gate, "revision-gate-release", () => gate.query("ROLLBACK"));
          await gate.query("BEGIN");
          const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]
            ?.pid;
          if (!gatePid) throw new Error("Missing root gate PID");
          await gate.query(
            "SELECT id FROM traceability_events WHERE tenant_id=$1 AND id=$2 FOR SHARE",
            [
              h.context.tenantId,
              kind === "Receiving" ? c.lifecycle.finalized.eventId : c.native.created.id,
            ],
          );
          const stores = datasetCorrectedTransformationStores(writer.db),
            args = { operationKey: randomUUID(), reason: "Synthetic actual root contention" };
          workers.writing = outcome<unknown>(
            kind === "Receiving"
              ? stores.receiving.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  c.lifecycle.finalized.eventId,
                  { ...args, commandVersion: 2, expectedLifecycleVersion: 4 },
                  randomUUID(),
                )
              : stores.transformation.amend(
                  h.context.tenantId,
                  h.context.actorUserId,
                  c.native.created.id,
                  { ...args, expectedLifecycleVersion: 2 },
                  randomUUID(),
                ),
          );
          await waitBlocked(h.f, gatePid, writerPid, signal);
          workers.reader = outcome(
            replay.db.transaction((tx) =>
              verifyUsDatasetCorrectedCases(
                tx,
                h.context,
                c.intent,
                c.receipt,
                "replay",
                datasetCorrectedTransformationStores(replay.db),
              ),
            ),
          );
          await waitBlocked(h.f, writerPid, replayPid, signal);
          await withOwnedWork(async (ownProbe) => {
            const probe = await h.f.pool.connect();
            ownClient(ownProbe, probe, "probe-rollback", () => probe.query("ROLLBACK"));
            await probe.query("BEGIN");
            expect(
              (
                await probe.query(
                  "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
                  [
                    h.context.tenantId,
                    [
                      ...c.input.receivingOrigin.inputLots.map(({ lotId }) => lotId),
                      c.input.outputLotId,
                    ],
                  ],
                )
              ).rowCount,
            ).toBe(3);
          });
          await abortable(ready(), signal);
          await gate.query("ROLLBACK");
          expect((await workers.writing).error).toBeUndefined();
          expect((await workers.reader).error).toMatchObject({
            message: "us_dataset_corrected_cases_mismatch",
          });
        }),
      );
      await observation.ready;
      observation.proceed();
      expect((await observation.running).error).toBeUndefined();
      await observation.cleanup();
    }),
  );
});
