import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  prepareDatasetShippingFixture,
  applyDatasetShippingFixture,
  type UsDatasetJournalFixture,
  type UsDatasetShippingFixturePrepared,
} from "./support/us-dataset-shipping-fixture";
import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { canonicalExportDigest } from "@markiro/domain";
import { usDatasetShippingRecordIds } from "../src/modules/traceability/demo/us-dataset-shipping-contract";
import { verifyUsDatasetShipping } from "../src/modules/traceability/demo/us-dataset-shipping-verify";
import type {
  UsDatasetReceipt,
  UsDatasetContext,
} from "../src/modules/traceability/demo/us-dataset-contract";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Shipping replay proof", () => {
  let f: UsDatasetJournalFixture;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US URL");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it.each(["header", "prerequisites", "absent", "pending"] as const)(
    "verify-only %s fails without writes",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision();
        if (kind === "prerequisites")
          await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        if (kind === "absent") {
          await new UsDatasetReferenceSeedStore(f.db).initialize(context);
          await new UsDatasetReceivingSeedStore(f.db).initialize(context, 0);
          await new UsDatasetTransformationSeedStore(f.db).initialize(context, 0);
          await new UsDatasetCasesSeedStore(f.db).initialize(context, 0);
        }
        if (kind === "pending") await prepareDatasetShippingFixture(f, context, 0);
        const before = await f.snapshot();
        await expect(new UsDatasetShippingSeedStore(f.db).verify(context, 0)).rejects.toThrow(
          "us_dataset_shipping_prerequisite_incomplete",
        );
        expect(await f.snapshot()).toEqual(before);
      }),
  );
  it("refuses actual preexisting native operations even with canonical input", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 0);
      await applyDatasetShippingFixture(f, context, prepared);
      const before = await f.snapshot();
      await expect(new UsDatasetShippingSeedStore(f.db).initialize(context, 0)).rejects.toThrow(
        "us_dataset_shipping_conflict",
      );
      await expect(new UsDatasetShippingSeedStore(f.db).verify(context, 0)).rejects.toThrow(
        "us_dataset_shipping_prerequisite_incomplete",
      );
      expect(await f.snapshot()).toEqual(before);
    }));
  it("fresh verification cannot adopt commands from an earlier native transaction", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 0);
      const result = await applyDatasetShippingFixture(f, context, prepared);
      const receipt = {
        result,
        recordIds: usDatasetShippingRecordIds(result),
        resultDigest: canonicalExportDigest(result),
      };
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          verifyUsDatasetShipping(
            tx,
            context,
            prepared.intent,
            receipt,
            { ...datasetTransformationStores(f.db), shipping: new UsShippingStore(f.db) },
            "fresh",
          ),
        ),
      ).rejects.toThrow("us_dataset_shipping_mismatch");
      expect(await f.snapshot()).toEqual(before);
    }));
  it("refuses an exact recipe document created by the native store", async () =>
    runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        prepared = await prepareDatasetShippingFixture(f, context, 0);
      const definition = prepared.input.chain.documents.find((row) =>
        row.key.includes("_shipping_"),
      );
      const { parseUsDatasetReferenceResult } =
        await import("../src/modules/traceability/demo/us-dataset-reference-contract");
      const refs = parseUsDatasetReferenceResult(prepared.references.receipt?.result);
      if (!definition) throw new Error("Missing Shipping document");
      const party = refs.bindings.parties.find((row) => row.key === definition.partyKey);
      if (!party) throw new Error("Missing native party");
      await datasetTransformationStores(f.db).documents.createDocument(
        context.tenantId,
        context.actorUserId,
        { ...definition.input, partyId: party.id },
        "preexisting-document",
      );
      const before = await f.snapshot();
      await expect(new UsDatasetShippingSeedStore(f.db).initialize(context, 0)).rejects.toThrow(
        "us_dataset_shipping_conflict",
      );
      expect(await f.snapshot()).toEqual(before);
    }));
  it.each(["owner", "tenant", "role", "database"] as const)(
    "guards current %s before hostile index/evidence",
    async (kind) =>
      runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          prepared = await prepareDatasetShippingFixture(f, context, 0);
        if (kind === "owner")
          await f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
            "changed owner",
            context.actorUserId,
          ]);
        if (kind === "role")
          await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        const checked = {
          ...context,
          ...(kind === "database" ? { expectedDatabaseName: "wrong_db" } : {}),
          ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
        };
        let touched = false;
        const hostile = {
          get result(): never {
            touched = true;
            throw new Error("hostile receipt");
          },
          recordIds: [],
          resultDigest: "0".repeat(64),
        } satisfies UsDatasetReceipt;
        const before = await f.snapshot();
        await expect(
          new UsDatasetShippingSeedStore(f.db).initialize(checked, Number.NaN),
        ).rejects.toThrow("us_dataset_target_invalid");
        await expect(
          f.db.transaction((tx) =>
            verifyUsDatasetShipping(
              tx,
              checked,
              prepared.intent,
              hostile,
              { ...datasetTransformationStores(f.db), shipping: new UsShippingStore(f.db) },
              "replay",
            ),
          ),
        ).rejects.toThrow("us_dataset_target_invalid");
        expect(touched).toBe(false);
        expect(await f.snapshot()).toEqual(before);
      }),
  );
  describe("prepared current native proof", () => {
    let context: UsDatasetContext;
    let prepared: UsDatasetShippingFixturePrepared;
    let setupMs = 0;
    beforeEach(async () =>
      runDatasetCasesFixtureBody(async () => {
        const started = performance.now();
        context = await f.provision();
        prepared = await prepareDatasetShippingFixture(f, context, 0);
        setupMs = performance.now() - started;
      }),
    );
    it.each([
      ["actor", "actor_user_id=NULL"],
      ["action", "action='changed'"],
      ["outcome", "outcome='failure'"],
      ["target", "target_id='changed'"],
      ["request", "request_id='changed'"],
      ["before", "before='{}'::jsonb"],
      ["after", "after='{}'::jsonb"],
      ["clock", "created_at=created_at+interval '1 second'"],
    ])("rejects partial native finalize audit %s drift without repair", async (_kind, set) =>
      runDatasetCasesFixtureBody(async () => {
        const started = performance.now();
        const seed = new UsDatasetShippingSeedStore(f.db),
          result = await seed.initialize(context, 0);
        const updated = await f.pool.query(
          `UPDATE tenant_audit_events SET ${set} WHERE organization_id=$1 AND target_id=$2 AND action='traceability.shipping.finalized'`,
          [context.tenantId, result.shipments[0]?.created.id],
        );
        expect(updated.rowCount).toBe(1);
        const before = await f.snapshot();
        await expect(seed.verify(context, 0)).rejects.toThrow("us_dataset_shipping_mismatch");
        expect(await f.snapshot()).toEqual(before);
        if (_kind === "actor")
          console.info("Task3 measured real fixture versus assertion body", {
            group: "audit drift",
            setupMs: Math.round(setupMs),
            bodyMs: Math.round(performance.now() - started),
            bodyBudgetMs: 5000,
          });
      }),
    );
    it.each(["amend", "pending void", "void", "status", "unlink", "extra consumer"] as const)(
      "rejects actual %s writer drift",
      async (kind) =>
        runDatasetCasesFixtureBody(async () => {
          const seed = new UsDatasetShippingSeedStore(f.db),
            result = await seed.initialize(context, 0),
            last = result.shipments.at(-1);
          if (!last) throw new Error("Missing shipment");
          const shipping = new UsShippingStore(f.db),
            command = {
              operationKey: randomUUID(),
              expectedLifecycleVersion: 2,
              reason: "Synthetic drift",
            };
          if (kind === "void")
            await shipping.void(
              context.tenantId,
              context.actorUserId,
              last.created.id,
              command,
              "public-void",
            );
          if (kind === "amend" || kind === "pending void") {
            const changed = await shipping.amend(
              context.tenantId,
              context.actorUserId,
              last.created.id,
              command,
              "public-amend",
            );
            if (kind === "pending void")
              await shipping.void(
                context.tenantId,
                context.actorUserId,
                changed.eventId,
                {
                  ...command,
                  operationKey: randomUUID(),
                  expectedLifecycleVersion: 3,
                  expectedDraftVersion: 1,
                },
                "public-pending-void",
              );
          }
          if (kind === "status")
            await datasetTransformationStores(f.db).lots.changeStatus(
              context.tenantId,
              context.actorUserId,
              result.input.outputLotId,
              { status: "quarantined", expectedRevision: 1, reason: "Synthetic status" },
              "public-status",
            );
          if (kind === "unlink") {
            const { parseUsDatasetCasesResult } =
              await import("../src/modules/traceability/demo/us-dataset-cases-contract");
            const c = parseUsDatasetCasesResult(prepared.cases.receipt?.result),
              first = c.linked.created[0];
            if (!first) throw new Error("Missing case");
            const { UsCaseStore } = await import("../src/modules/traceability/cases/us-case-store");
            await new UsCaseStore(f.db).unlink(
              context.tenantId,
              context.actorUserId,
              result.input.outputLotId,
              first.linkId,
              { operationKey: randomUUID(), reason: "Synthetic unlink" },
              "public-unlink",
            );
          }
          if (kind === "extra consumer") {
            const created = await shipping.createDraft(
              context.tenantId,
              context.actorUserId,
              {
                operationKey: randomUUID(),
                draft: {
                  ...last.createInput.draft,
                  items: [
                    { lotId: result.input.outputLotId, quantity: "1", unitOfMeasure: "case" },
                  ],
                },
              },
              "extra-create",
            );
            const ready = await shipping.checkReadiness(
              context.tenantId,
              context.actorUserId,
              created.id,
              { expectedDraftVersion: 1 },
            );
            expect(ready.state).toBe("complete");
            await shipping.finalize(
              context.tenantId,
              context.actorUserId,
              created.id,
              {
                operationKey: randomUUID(),
                expectedDraftVersion: 1,
                expectedInputDigest: ready.inputDigest,
              },
              "extra-finalize",
            );
          }
          const before = await f.snapshot();
          await expect(seed.verify(context, 0)).rejects.toThrow(/mismatch/);
          expect(await f.snapshot()).toEqual(before);
        }),
    );
  });
});
