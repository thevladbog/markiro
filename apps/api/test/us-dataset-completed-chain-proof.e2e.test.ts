import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { parseUsDatasetCasesResult } from "../src/modules/traceability/demo/us-dataset-cases-contract";
import { parseUsDatasetReceivingResult } from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { parseUsDatasetTransformationResult } from "../src/modules/traceability/demo/us-dataset-transformation-contract";
import { parseUsDatasetShippingResult } from "../src/modules/traceability/demo/us-dataset-shipping-contract";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { countActualQueries } from "./support/us-dataset-query-counter";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { ownClient, withOwnedWork } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("completed regular chain live terminal proof", () => {
  const h = specialFixture(base);
  const range = { startIndex: 0, count: 1 };
  const stages = ["receiving", "transformation", "cases", "shipping"] as const;
  async function completed() {
    const { f, context } = h;
    const seed = new UsDatasetRegularSeedStore(f.db);
    const result = await seed.initialize(context, range);
    const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
    return { f, context, seed, result, journal };
  }
  // Negative evidence only in the fixture-owned child. Restore triggers before
  // committing and retain rollback/release ownership if any statement fails.
  async function corrupt(table: string, query: string, values: unknown[]) {
    await withOwnedWork(async (own) => {
      const client = await h.f.pool.connect();
      ownClient(own, client, "completed-proof-corruption", () => client.query("ROLLBACK"));
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      const changed = await client.query(query, values);
      expect(changed.rowCount).toBeGreaterThan(0);
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      await client.query("COMMIT");
    });
  }
  async function deniedBoth(
    seed: UsDatasetRegularSeedStore,
    expected: { stage: string; unitKey: string },
  ) {
    const before = await h.f.snapshot();
    for (const mode of ["verify", "initialize"] as const) {
      await expect(seed[mode](h.context, range)).rejects.toMatchObject({
        ...expected,
        message: expect.stringMatching(/^us_dataset_/),
      });
      expect(await h.f.snapshot()).toEqual(before);
    }
    console.info("Task6 denied without repair", {
      ...expected,
      tables: Object.keys(before).length,
      hash: canonicalExportDigest(before),
    });
  }
  it(
    "proves completed chain with at most 650 actual queries and no writes in both modes",
    h.phase(async () => {
      const { f, context } = h;
      const seed = new UsDatasetRegularSeedStore(f.db);
      const range = { startIndex: 0, count: 1 };
      const initialized = await seed.initialize(context, range);
      expect(initialized.chains).toEqual([
        {
          index: 0,
          unitKey: "chain_0000",
          shipmentCount: 2,
          shippingResultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
      const before = await f.snapshot();
      for (const mode of ["verify", "initialize"] as const) {
        const measured = await countActualQueries(f.pool, () => seed[mode](context, range));
        expect(measured.value).toEqual(initialized);
        expect(await f.snapshot()).toEqual(before);
        console.info("Task6 completed chain proof", {
          mode,
          queries: measured.count,
          durationMs: measured.durationMs,
          tables: Object.keys(before).length,
          hash: canonicalExportDigest(before),
          summaryDigest: canonicalExportDigest(measured.value),
        });
        expect(measured.count).toBeLessThanOrEqual(650);
      }
    }),
    60_000,
  );

  it.each(
    stages.flatMap((stage) =>
      (["intent", "receipt", "result"] as const).map((layer) => ({ stage, layer })),
    ),
  )(
    "rejects completed $stage $layer drift with intact completion markers",
    h.phase(async ({ stage, layer }) => {
      const { f, context, seed, journal, result } = await completed();
      const row = await journal.readStage(context, result.datasetId, "chain_0000", stage);
      if (!row?.receipt) throw new Error("Missing completed fixture receipt");
      if (layer === "intent") {
        await corrupt(
          "traceability_demo_dataset_stages",
          "UPDATE traceability_demo_dataset_stages SET operation_key=$3 WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage=$2",
          [context.tenantId, stage, randomUUID()],
        );
      } else {
        const changedResult =
          layer === "result" ? { ...row.receipt.result, syntheticDrift: true } : row.receipt.result;
        const receipt = {
          ...row.receipt,
          result: changedResult,
          resultDigest: canonicalExportDigest(changedResult),
          recordIds: layer === "receipt" ? [randomUUID()] : row.receipt.recordIds,
        };
        await corrupt(
          "traceability_demo_dataset_stages",
          "UPDATE traceability_demo_dataset_stages SET receipt=$3::jsonb WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage=$2",
          [context.tenantId, stage, JSON.stringify(receipt)],
        );
      }
      expect(
        (
          await f.pool.query(
            "SELECT revision,receipt IS NOT NULL AS completed FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='chain_0000' ORDER BY stage",
            [context.tenantId],
          )
        ).rows,
      ).toEqual(stages.map(() => ({ revision: 2, completed: true })));
      await deniedBoth(seed, { stage: "shipping", unitKey: "chain_0000" });
    }),
    60_000,
  );

  it.each([
    ["Receiving native", "receiving_event_items", "quantity='499'", "tenant_id", ""],
    [
      "Receiving audit",
      "tenant_audit_events",
      "after='{}'::jsonb",
      "organization_id",
      " AND action='traceability.receiving.finalized'",
    ],
    ["Receiving operation", "receiving_operations", "input_digest=repeat('0',64)", "tenant_id", ""],
    [
      "Receiving root",
      "receiving_event_roots",
      "lifecycle_version=lifecycle_version+1",
      "tenant_id",
      "",
    ],
    ["Transformation native", "transformation_event_outputs", "quantity='1'", "tenant_id", ""],
    [
      "Transformation audit",
      "tenant_audit_events",
      "after='{}'::jsonb",
      "organization_id",
      " AND action='traceability.transformation.finalized'",
    ],
    [
      "Transformation operation",
      "transformation_operations",
      "input_digest=repeat('0',64)",
      "tenant_id",
      "",
    ],
    [
      "Transformation root",
      "transformation_event_roots",
      "lifecycle_version=lifecycle_version+1",
      "tenant_id",
      "",
    ],
    ["Cases native", "boxes", "device_box_id='changed-' || id::text", "tenant_id", ""],
    ["Cases support", "shifts", "planned_qty=1", "tenant_id", ""],
    [
      "Cases provenance",
      "traceability_synthetic_case_origins",
      "seed_id='foreign-seed'",
      "tenant_id",
      "",
    ],
    [
      "Cases audit",
      "tenant_audit_events",
      "after='{}'::jsonb",
      "organization_id",
      " AND action='case.link'",
    ],
    ["Cases operation", "trace_lot_box_operations", "input_digest=repeat('0',64)", "tenant_id", ""],
    ["Shipping native", "shipping_event_items", "quantity='1'", "tenant_id", ""],
    [
      "Shipping audit",
      "tenant_audit_events",
      "after='{}'::jsonb",
      "organization_id",
      " AND action='traceability.shipping.finalized'",
    ],
    ["Shipping operation", "shipping_operations", "input_digest=repeat('0',64)", "tenant_id", ""],
    [
      "Shipping root",
      "shipping_event_roots",
      "lifecycle_version=lifecycle_version+1",
      "tenant_id",
      "",
    ],
    [
      "output balance",
      "traceability_lots",
      "status='archived',revision=revision+1",
      "tenant_id",
      " AND id IN (SELECT lot_id FROM transformation_event_outputs WHERE tenant_id=$1)",
    ],
    ["upstream document", "reference_documents", "notes='Native drift'", "tenant_id", ""],
    ["genealogy", "lot_genealogy_edges", "", "tenant_id", ""],
  ])(
    "retains complete native proof of %s without fallback writes",
    h.phase(async (_name, table, set, tenantColumn, filter) => {
      const { context, seed } = await completed();
      await corrupt(
        table,
        table === "lot_genealogy_edges"
          ? "DELETE FROM lot_genealogy_edges WHERE tenant_id=$1"
          : `UPDATE ${table} SET ${set} WHERE ${tenantColumn}=$1${filter}`,
        [context.tenantId],
      );
      await deniedBoth(seed, { stage: "shipping", unitKey: "chain_0000" });
    }),
    60_000,
  );

  it.each(["intent", "receipt", "result", "native"] as const)(
    "retains References %s proof through global and live nested verification",
    h.phase(async (layer) => {
      const { context, seed, journal, result } = await completed();
      if (layer === "native") {
        await corrupt(
          "traceability_parties",
          "UPDATE traceability_parties SET name='Changed reference ' || name WHERE tenant_id=$1",
          [context.tenantId],
        );
      } else if (layer === "intent") {
        await corrupt(
          "traceability_demo_dataset_stages",
          "UPDATE traceability_demo_dataset_stages SET operation_key=$2 WHERE tenant_id=$1 AND stage='references'",
          [context.tenantId, randomUUID()],
        );
      } else {
        const row = await journal.readStage(context, result.datasetId, "references", "references");
        if (!row?.receipt) throw new Error("Missing references receipt");
        const changedResult =
          layer === "result" ? { ...row.receipt.result, syntheticDrift: true } : row.receipt.result;
        await corrupt(
          "traceability_demo_dataset_stages",
          "UPDATE traceability_demo_dataset_stages SET receipt=$2::jsonb WHERE tenant_id=$1 AND stage='references'",
          [
            context.tenantId,
            JSON.stringify({
              ...row.receipt,
              result: changedResult,
              resultDigest: canonicalExportDigest(changedResult),
              recordIds: layer === "receipt" ? [randomUUID()] : row.receipt.recordIds,
            }),
          ],
        );
      }
      await deniedBoth(
        seed,
        layer === "intent"
          ? { stage: "shipping", unitKey: "chain_0000" }
          : { stage: "references", unitKey: "references" },
      );
    }),
    60_000,
  );

  it.each([
    ["current role", "member", "UPDATE member SET role='viewer' WHERE organization_id=$1"],
    ["profile", "traceability_profiles", "DELETE FROM traceability_profiles WHERE tenant_id=$1"],
    [
      "timezone",
      "org_profiles",
      "UPDATE org_profiles SET time_zone='America/Chicago' WHERE tenant_id=$1",
    ],
    ["provenance", "organization", "UPDATE organization SET metadata='{}' WHERE id=$1"],
    [
      "owner audit",
      "tenant_audit_events",
      "UPDATE tenant_audit_events SET after='{}'::jsonb WHERE organization_id=$1 AND action='us.development.owner.provisioned'",
    ],
  ])(
    "reloads %s after a completed successful call",
    h.phase(async (_name, table, query) => {
      const { context, seed } = await completed();
      await seed.verify(context, range);
      await corrupt(table, query, [context.tenantId]);
      await deniedBoth(seed, { stage: "target", unitKey: "unknown" });
    }),
    60_000,
  );

  it(
    "rejects a real foreign tenant using the same completed store",
    h.phase(async () => {
      const { f, context, seed, journal, result } = await completed();
      const foreignTenantId = randomUUID();
      await f.pool.query(
        "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Foreign synthetic tenant',$1,now())",
        [foreignTenantId],
      );
      const foreign = { ...context, tenantId: foreignTenantId };
      const before = await f.snapshot();
      for (const mode of ["verify", "initialize"] as const) {
        await expect(seed[mode]({ ...context, tenantId: foreign.tenantId }, range)).rejects.toThrow(
          "us_dataset_target_invalid",
        );
      }
      await expect(
        journal.readStageCompletions(foreign, result.datasetId, [
          { unitKey: "chain_0000", stage: "shipping" },
        ]),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );

  it.each(
    stages.flatMap((stage) => (["missing", "pending"] as const).map((state) => ({ stage, state }))),
  )(
    "retains ordered verification for $state $stage and never installs missing state",
    h.phase(async ({ stage, state }) => {
      const { f, context, seed } = await completed();
      await corrupt(
        "traceability_demo_dataset_stages",
        state === "missing"
          ? "DELETE FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage=$2"
          : "UPDATE traceability_demo_dataset_stages SET receipt=NULL,revision=1 WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage=$2",
        [context.tenantId, stage],
      );
      const before = await f.snapshot();
      await expect(seed.verify(context, range)).rejects.toMatchObject({
        stage,
        unitKey: "chain_0000",
      });
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );

  it(
    "stops partial Receiving drift before Transformation and the next chain",
    h.phase(async () => {
      const { f, context, seed, result, journal } = await completed();
      const receiving = await new UsDatasetReceivingSeedStore(f.db).initialize(context, 1);
      await corrupt(
        "tenant_audit_events",
        "UPDATE tenant_audit_events SET after='{}'::jsonb WHERE organization_id=$1 AND target_id=$2 AND action='traceability.receiving.finalized'",
        [context.tenantId, receiving.created.eventId],
      );
      const before = await f.snapshot();
      await expect(seed.initialize(context, { startIndex: 0, count: 3 })).rejects.toMatchObject({
        message: "us_dataset_receiving_mismatch",
        stage: "receiving",
        unitKey: "chain_0001",
      });
      expect(
        await journal.readStage(context, result.datasetId, "chain_0001", "transformation"),
      ).toBeNull();
      expect(
        await journal.readStage(context, result.datasetId, "chain_0002", "receiving"),
      ).toBeNull();
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );

  it(
    "uses terminal-first error priority for combined completed defects without repair",
    h.phase(async () => {
      const { context, seed } = await completed();
      await corrupt(
        "tenant_audit_events",
        "UPDATE tenant_audit_events SET after='{}'::jsonb WHERE organization_id=$1 AND action='traceability.receiving.finalized'",
        [context.tenantId],
      );
      await corrupt(
        "shipping_operations",
        "UPDATE shipping_operations SET input_digest=repeat('0',64) WHERE tenant_id=$1",
        [context.tenantId],
      );
      const before = await h.f.snapshot();
      for (const mode of ["verify", "initialize"] as const) {
        await expect(seed[mode](context, range)).rejects.toMatchObject({
          stage: "shipping",
          unitKey: "chain_0000",
          message: "us_dataset_cases_mismatch",
          cause: {
            message: "us_dataset_transformation_mismatch",
            cause: { message: "us_dataset_receiving_mismatch" },
          },
        });
        expect(await h.f.snapshot()).toEqual(before);
      }
    }),
    60_000,
  );
  it(
    "preserves Receiving-first partial priority despite malformed downstream intent",
    h.phase(async () => {
      const { f, context, seed } = await completed();
      await corrupt(
        "tenant_audit_events",
        "UPDATE tenant_audit_events SET after='{}'::jsonb WHERE organization_id=$1 AND action='traceability.receiving.finalized'",
        [context.tenantId],
      );
      await corrupt(
        "traceability_demo_dataset_stages",
        "UPDATE traceability_demo_dataset_stages SET input_digest=repeat('0',64) WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage='transformation'",
        [context.tenantId],
      );
      await corrupt(
        "traceability_demo_dataset_stages",
        "UPDATE traceability_demo_dataset_stages SET receipt=NULL,revision=1 WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage='shipping'",
        [context.tenantId],
      );
      const before = await f.snapshot();
      // The original first-stage proof still diagnoses the native Receiving fact.
      await expect(new UsDatasetReceivingSeedStore(f.db).verify(context, 0)).rejects.toThrow(
        "us_dataset_receiving_mismatch",
      );
      for (const mode of ["verify", "initialize"] as const) {
        await expect(seed[mode](context, range)).rejects.toMatchObject({
          message: "us_dataset_receiving_mismatch",
          stage: "receiving",
          unitKey: "chain_0000",
        });
        expect(await f.snapshot()).toEqual(before);
      }
    }),
    60_000,
  );
  it.each(["receiving", "transformation", "shipping", "unlink", "extra shipment"] as const)(
    "rejects actual public %s lifecycle or balance changes after completion",
    h.phase(async (kind) => {
      const { f, context, seed, journal, result } = await completed();
      const receiving = await journal.readStage(
        context,
        result.datasetId,
        "chain_0000",
        "receiving",
      );
      const transformation = await journal.readStage(
        context,
        result.datasetId,
        "chain_0000",
        "transformation",
      );
      const cases = await journal.readStage(context, result.datasetId, "chain_0000", "cases");
      const shipping = await journal.readStage(context, result.datasetId, "chain_0000", "shipping");
      const args = {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Synthetic lifecycle drift",
      };
      if (kind === "receiving") {
        const saved = parseUsDatasetReceivingResult(receiving?.receipt?.result);
        await new UsReceivingStore(f.db).amend(
          context.tenantId,
          context.actorUserId,
          saved.created.eventId,
          { ...args, commandVersion: 2 },
          "task6-amend-receiving",
        );
      } else if (kind === "transformation") {
        const saved = parseUsDatasetTransformationResult(transformation?.receipt?.result);
        await new UsTransformationStore(f.db).amend(
          context.tenantId,
          context.actorUserId,
          saved.created.id,
          args,
          "task6-amend-transformation",
        );
      } else if (kind === "unlink") {
        const saved = parseUsDatasetCasesResult(cases?.receipt?.result);
        const first = saved.linked.created[0];
        if (!first) throw new Error("Missing fixture case link");
        await new UsCaseStore(f.db).unlink(
          context.tenantId,
          context.actorUserId,
          saved.input.outputLotId,
          first.linkId,
          { operationKey: randomUUID(), reason: "Synthetic unlink" },
          "task6-unlink",
        );
      } else {
        const saved = parseUsDatasetShippingResult(shipping?.receipt?.result);
        const last = saved.shipments.at(-1);
        if (!last) throw new Error("Missing fixture shipment");
        const store = new UsShippingStore(f.db);
        if (kind === "shipping") {
          await store.amend(
            context.tenantId,
            context.actorUserId,
            last.created.id,
            args,
            "task6-amend-shipping",
          );
        } else {
          const created = await store.createDraft(
            context.tenantId,
            context.actorUserId,
            {
              operationKey: randomUUID(),
              draft: {
                ...last.createInput.draft,
                items: [{ lotId: saved.input.outputLotId, quantity: "1", unitOfMeasure: "case" }],
              },
            },
            "task6-extra-create",
          );
          const ready = await store.checkReadiness(
            context.tenantId,
            context.actorUserId,
            created.id,
            { expectedDraftVersion: 1 },
          );
          expect(ready.state).toBe("complete");
          await store.finalize(
            context.tenantId,
            context.actorUserId,
            created.id,
            {
              operationKey: randomUUID(),
              expectedDraftVersion: 1,
              expectedInputDigest: ready.inputDigest,
            },
            "task6-extra-finalize",
          );
        }
      }
      await deniedBoth(seed, { stage: "shipping", unitKey: "chain_0000" });
    }),
    60_000,
  );

  it(
    "public batch preserves ordered nullable reads and fresh guards even when empty",
    h.phase(async () => {
      const { f, context, journal, result } = await completed();
      const requests = [
        { unitKey: "chain_0000", stage: "shipping" as const },
        { unitKey: "chain_0001", stage: "receiving" as const },
        { unitKey: "chain_0000", stage: "receiving" as const },
        { unitKey: "chain_0000", stage: "shipping" as const },
      ];
      const before = await f.snapshot();
      const rows = await journal.readStageCompletions(context, result.datasetId, requests);
      expect(rows.map((row) => row?.stage ?? null)).toEqual([
        "shipping",
        null,
        "receiving",
        "shipping",
      ]);
      expect(rows[0]).toEqual(rows[3]);
      expect(rows[0]).not.toBe(rows[3]);
      expect(rows[0]).toEqual({
        unitKey: "chain_0000",
        stage: "shipping",
        revision: 2,
        receiptPresent: true,
      });
      expect(await journal.readStageCompletions(context, result.datasetId, [])).toEqual([]);
      await expect(journal.readStageCompletions(context, randomUUID(), requests)).rejects.toThrow(
        "us_dataset_conflict",
      );
      await expect(
        journal.readStageCompletions(
          context,
          result.datasetId,
          Array.from({ length: 257 }, () => ({
            unitKey: "chain_0000",
            stage: "shipping" as const,
          })),
        ),
      ).rejects.toThrow("us_dataset_unit_invalid");
      expect(await f.snapshot()).toEqual(before);
      await corrupt(
        "traceability_demo_dataset_stages",
        "UPDATE traceability_demo_dataset_stages SET receipt=NULL,revision=1 WHERE tenant_id=$1 AND unit_key='chain_0000' AND stage='shipping'",
        [context.tenantId],
      );
      expect((await journal.readStageCompletions(context, result.datasetId, requests))[0]).toEqual({
        unitKey: "chain_0000",
        stage: "shipping",
        revision: 1,
        receiptPresent: false,
      });
      await corrupt(
        "traceability_demo_datasets",
        "UPDATE traceability_demo_datasets SET definition_digest=repeat('0',64) WHERE tenant_id=$1",
        [context.tenantId],
      );
      await expect(journal.readStageCompletions(context, result.datasetId, [])).rejects.toThrow(
        "us_dataset_journal_invalid",
      );
      await corrupt("member", "UPDATE member SET role='viewer' WHERE organization_id=$1", [
        context.tenantId,
      ]);
      const changed = await f.snapshot();
      await expect(journal.readStageCompletions(context, result.datasetId, [])).rejects.toThrow(
        "us_dataset_target_invalid",
      );
      expect(await f.snapshot()).toEqual(changed);
    }),
    60_000,
  );
});
