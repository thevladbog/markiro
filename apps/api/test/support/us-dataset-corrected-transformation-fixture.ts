import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import {
  createTransformationDraftSchema,
  finalizeTransformationSchema,
} from "@markiro/platform-contracts";
import type {
  UsDatasetContext,
  UsDatasetIntent,
} from "../../src/modules/traceability/demo/us-dataset-contract";
import type { UsDemoTransaction } from "../../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import { UsDatasetJournalStore } from "../../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetSpecialSeedStore } from "../../src/modules/traceability/demo/us-dataset-special-seed";
import { parseUsDatasetSpecialResult } from "../../src/modules/traceability/demo/us-dataset-special-contract";
import { makeUsDatasetCorrectedTransformationInput } from "../../src/modules/traceability/demo/us-dataset-corrected-transformation-contract";
import { makeUsDatasetReferenceIdentity } from "../../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  parseUsDatasetCorrectedTransformationResult,
  usDatasetCorrectedTransformationRecordIds,
} from "../../src/modules/traceability/demo/us-dataset-corrected-transformation-result";
import { US_DATASET_TRANSFORMATION_METADATA } from "../../src/modules/traceability/demo/us-dataset-transformation-content";
import { usSixMonthDefinition } from "../../src/modules/traceability/demo/us-six-month-definition";
import { UsCatalogStore } from "../../src/modules/traceability/catalog/us-catalog-store";
import { UsReferenceDocumentStore } from "../../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../../src/modules/traceability/lots/us-lot-store";
import { UsMasterDataStore } from "../../src/modules/traceability/master-data/us-master-data-store";
import { UsProductProfileStore } from "../../src/modules/traceability/products/us-product-profile-store";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../../src/modules/traceability/transformation/us-transformation-store";
import type { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";

export function datasetCorrectedTransformationStores(db: Db) {
  return {
    journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
    master: new UsMasterDataStore(db),
    catalog: new UsCatalogStore(db),
    profiles: new UsProductProfileStore(db),
    documents: new UsReferenceDocumentStore(db),
    lots: new UsLotStore(db),
    receiving: new UsReceivingStore(db),
    transformation: new UsTransformationStore(db),
  };
}
function bound(entries: readonly { key: string; id: string }[], key: string): string {
  const found = entries.find((e) => e.key === key);
  if (!found) throw new Error("Missing native fixture binding");
  return found.id;
}

/** Real installed prerequisites, then local native composition; no seed SQL or executor under test. */
export async function prepareDatasetCorrectedTransformation(db: Db, context: UsDatasetContext) {
  const stores = datasetCorrectedTransformationStores(db);
  const references = await new UsDatasetReferenceSeedStore(db).initialize(context);
  await new UsDatasetSpecialSeedStore(db).initialize(context, "correction");
  const header = await stores.journal.read(context);
  if (!header) throw new Error("Missing fixture dataset");
  const referenceStage = await stores.journal.readStage(
    context,
    header.id,
    "references",
    "references",
  );
  const originalStage = await stores.journal.readStage(
    context,
    header.id,
    "correction_0001",
    "receiving",
  );
  const amendmentStage = await stores.journal.readStage(
    context,
    header.id,
    "correction_0001",
    "amend_receiving",
  );
  if (!referenceStage?.receipt || !originalStage?.receipt || !amendmentStage?.receipt)
    throw new Error("Missing persisted corrected prerequisites");
  const lifecycle = parseUsDatasetSpecialResult(amendmentStage.receipt.result);
  const original = parseUsDatasetSpecialResult(originalStage.receipt.result);
  if (lifecycle.stage !== "amend_receiving" || original.stage !== "receiving")
    throw new Error("Wrong persisted corrected prerequisite stages");
  const input = makeUsDatasetCorrectedTransformationInput(
    makeUsDatasetReferenceIdentity(header.id, referenceStage),
    amendmentStage,
  );
  const operationKey = randomUUID();
  const intent: UsDatasetIntent = {
    unitKey: input.chain.unitKey,
    stage: "transformation",
    operationKey,
    input,
    inputDigest: canonicalExportDigest(input),
  };
  async function apply(tx: UsDemoTransaction) {
    const documents = [];
    for (const number of input.chain.transformation.references) {
      const definition = input.chain.documents.find((d) => d.input.number === number);
      if (!definition) throw new Error("Missing fixture document");
      documents.push({
        key: definition.key,
        record: await stores.documents.createDocumentInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          { ...definition.input, partyId: bound(references.bindings.parties, definition.partyKey) },
          operationKey,
        ),
      });
    }
    const createInput = createTransformationDraftSchema.parse({
      operationKey,
      draft: {
        eventDate: input.chain.transformation.eventDate,
        processorLocationId: bound(
          references.bindings.locations,
          input.chain.transformation.locationKey,
        ),
        ...US_DATASET_TRANSFORMATION_METADATA,
        documentIds: documents.map((d) => d.record.id),
        inputs: input.chain.transformation.inputs.map((line, i) => ({
          kind: "ftl_lot",
          lotId: input.receivingOrigin.inputLots[i]?.lotId,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
        })),
        outputs: [
          {
            productId: bound(
              references.bindings.products,
              input.chain.transformation.output.productKey,
            ),
            tlc: input.chain.transformation.output.tlc,
            quantity: input.chain.transformation.output.quantity,
            unitOfMeasure: input.chain.transformation.output.unitOfMeasure,
          },
        ],
      },
    });
    const created = await stores.transformation.createDraftInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      createInput,
      operationKey,
    );
    const ready = await stores.transformation.checkReadinessInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      { expectedDraftVersion: created.draftVersion },
    );
    if (ready.state !== "complete") throw new Error("Native fixture transformation incomplete");
    const finalizeInput = finalizeTransformationSchema.parse({
      operationKey,
      expectedDraftVersion: created.draftVersion,
      expectedInputDigest: ready.inputDigest,
    });
    const finalized = await stores.transformation.finalizeInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      finalizeInput,
      operationKey,
    );
    const output = finalized.snapshot.outputs[0];
    if (!output) throw new Error("Missing native output");
    const outputLot = await stores.lots.getLotInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      output.lotId,
    );
    const result = parseUsDatasetCorrectedTransformationResult({
      input,
      documents,
      createInput,
      finalizeInput,
      created,
      finalized,
      outputLot,
      inputLots: input.receivingOrigin.inputLots,
    });
    return {
      result,
      resultDigest: canonicalExportDigest(result),
      recordIds: usDatasetCorrectedTransformationRecordIds(result),
    };
  }
  return {
    stores,
    header,
    references,
    referenceStage,
    original,
    lifecycle,
    originalStage,
    amendmentStage,
    input,
    intent,
    apply,
  };
}

type Fixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
/** Invocation-owned failpoints live only in the fixture's randomized child DB. */
export async function correctedTransformationFault(
  f: Fixture,
  table: string,
  action: string,
  condition: string,
  code = "P0001",
  corrupt = false,
) {
  if (
    ![
      "reference_documents",
      "transformation_event_details",
      "traceability_lots",
      "lot_genealogy_edges",
      "tenant_audit_events",
      "transformation_operations",
      "traceability_demo_dataset_stages",
    ].includes(table) ||
    !["INSERT", "UPDATE"].includes(action)
  )
    throw new Error("Invalid owned corrected fault target");
  const name = "corrected_fault_" + randomUUID().replaceAll("-", "");
  let functionCreated = false,
    triggerCreated = false;
  const remove = async () => {
    const failures: unknown[] = [];
    if (triggerCreated)
      try {
        await f.pool.query(`DROP TRIGGER ${name} ON ${table}`);
        triggerCreated = false;
      } catch (error) {
        failures.push(error);
      }
    if (functionCreated)
      try {
        await f.pool.query(`DROP FUNCTION ${name}()`);
        functionCreated = false;
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, "Owned corrected fault removal failed");
  };
  try {
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${corrupt ? "UPDATE reference_documents SET notes='Synthetic corrected verifier drift';" : `RAISE EXCEPTION 'corrected_sql_fault' USING ERRCODE='${code}';`} END IF; RETURN NEW; END $$`,
    );
    functionCreated = true;
    await f.pool.query(
      `CREATE TRIGGER ${name} ${corrupt ? "AFTER" : "BEFORE"} ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    triggerCreated = true;
    return remove;
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Negative probes alter existing native rows only, never fabricate successful receipts. */
export async function corruptCorrectedTransformation(
  f: Fixture,
  table: string,
  query: string,
  values: readonly unknown[],
) {
  if (
    ![
      "traceability_lots",
      "traceability_events",
      "receiving_event_roots",
      "receiving_event_items",
      "transformation_event_roots",
      "transformation_event_inputs",
      "transformation_event_outputs",
      "transformation_event_details",
      "lot_genealogy_edges",
      "transformation_operations",
      "reference_documents",
      "traceability_demo_dataset_stages",
      "tenant_audit_events",
      "products",
    ].includes(table)
  )
    throw new Error("Invalid owned corrected drift target");
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    const changed = await client.query(query, [...values]);
    if (!changed.rowCount) throw new Error("Missing native drift row");
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A genuine later Transformation consumes one case; its draft is rolled back on failure. */
export async function consumeCorrectedTransformation(
  db: Db,
  context: UsDatasetContext,
  result: ReturnType<typeof parseUsDatasetCorrectedTransformationResult>,
) {
  const stores = datasetCorrectedTransformationStores(db);
  return db.transaction(async (tx) => {
    const key = randomUUID();
    const output = result.createInput.draft.outputs[0];
    if (!output) throw new Error("Missing native consumer output");
    const created = await stores.transformation.createDraftInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      {
        operationKey: key,
        draft: {
          ...result.createInput.draft,
          inputs: [
            { kind: "ftl_lot", lotId: result.outputLot.id, quantity: "1", unitOfMeasure: "case" },
          ],
          outputs: [{ ...output, tlc: "Synthetic-consumer-" + key, quantity: "1" }],
        },
      },
      key,
    );
    const ready = await stores.transformation.checkReadinessInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      { expectedDraftVersion: 1 },
    );
    if (ready.state !== "complete") throw new Error("Native consumer incomplete");
    return stores.transformation.finalizeInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      { operationKey: key, expectedDraftVersion: 1, expectedInputDigest: ready.inputDigest },
      key,
    );
  });
}
