import { verifyUsDatasetReceivingFinal } from "./us-dataset-native-final-verify.js";
import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { UsReceivingStore } from "../receiving/us-receiving-store.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetReceipt,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import {
  datasetReceivingError,
  makeUsDatasetReceivingInput,
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingInput,
  parseUsDatasetReceivingResult,
  usDatasetReceivingRecordIds,
  type UsDatasetReceivingInput,
  type UsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import { type UsDatasetReceivingStores } from "./us-dataset-receiving-verify.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { verifyUsDatasetReferences } from "./us-dataset-reference-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

const same = (a: unknown, b: unknown) => canonicalExportDigest(a) === canonicalExportDigest(b);
function checkedStage(stage: UsDatasetStageRow | null, input: UsDatasetReceivingInput) {
  if (
    stage &&
    (stage.unitKey !== input.chain.unitKey ||
      stage.stage !== "receiving" ||
      !same(stage.intent.input, input))
  )
    throw datasetReceivingError("us_dataset_receiving_dependency_conflict", input.chain.unitKey);
  return stage;
}

/** Internal regular-chain executor. Catalogue installation is an explicit prerequisite. */
export class UsDatasetReceivingSeedStore {
  private readonly stores: UsDatasetReceivingStores;
  constructor(db: Db) {
    this.stores = {
      journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
      master: new UsMasterDataStore(db),
      catalog: new UsCatalogStore(db),
      profiles: new UsProductProfileStore(db),
      documents: new UsReferenceDocumentStore(db),
      lots: new UsLotStore(db),
      receiving: new UsReceivingStore(db),
    };
  }
  initialize(context: UsDatasetContext, index: number): Promise<UsDatasetReceivingResult> {
    return this.execute(context, index, true);
  }
  verify(context: UsDatasetContext, index: number): Promise<UsDatasetReceivingResult> {
    return this.execute(context, index, false);
  }
  private async execute(
    context: UsDatasetContext,
    index: number,
    capture: boolean,
  ): Promise<UsDatasetReceivingResult> {
    const journal = this.stores.journal;
    // Target/owner authorization precedes interpreting the requested recipe index.
    const header = await journal.read(context);
    if (!header)
      throw datasetReceivingError("us_dataset_receiving_prerequisite_incomplete", "unknown");
    const references = await journal.readStage(context, header.id, "references", "references");
    if (!references?.receipt)
      throw datasetReceivingError("us_dataset_receiving_prerequisite_incomplete", "references");
    const input = makeUsDatasetReceivingInput(
      index,
      makeUsDatasetReferenceIdentity(header.id, references),
    );
    let stage = checkedStage(
      await journal.readStage(context, header.id, input.chain.unitKey, "receiving"),
      input,
    );
    if (!stage && capture) {
      const intent: UsDatasetIntent = {
        unitKey: input.chain.unitKey,
        stage: "receiving",
        operationKey: randomUUID(),
        input,
        inputDigest: canonicalExportDigest(input),
      };
      try {
        stage = checkedStage(await journal.captureIntent(context, header.id, intent), input);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
          throw error;
        stage = checkedStage(
          await journal.readStage(context, header.id, input.chain.unitKey, "receiving"),
          input,
        );
        if (!stage) throw error;
      }
    }
    if (!stage || (!capture && !stage.receipt))
      throw datasetReceivingError(
        "us_dataset_receiving_prerequisite_incomplete",
        input.chain.unitKey,
      );
    const completed = await journal.runAtomicStage(
      context,
      header.id,
      stage.revision,
      stage.intent,
      {
        apply: (tx, checked, intent) => {
          if (!capture)
            throw datasetReceivingError(
              "us_dataset_receiving_prerequisite_incomplete",
              input.chain.unitKey,
            );
          return this.apply(tx, checked, intent);
        },
        verify: (tx, checked, intent, receipt) =>
          verifyUsDatasetReceivingFinal(tx, checked, intent, receipt, this.stores),
      },
    );
    if (!completed.receipt)
      throw datasetReceivingError(
        "us_dataset_receiving_prerequisite_incomplete",
        input.chain.unitKey,
      );
    return parseUsDatasetReceivingResult(completed.receipt.result);
  }
  private async apply(
    tx: UsDemoTransaction,
    context: UsDatasetContext,
    intent: UsDatasetIntent,
  ): Promise<UsDatasetReceipt> {
    const input = parseUsDatasetReceivingInput(intent.input);
    const fail = () => datasetReceivingError("us_dataset_receiving_conflict", intent.unitKey);
    const references = await this.stores.journal.readStageInTransaction(
      tx,
      context,
      input.references.datasetId,
      "references",
      "references",
    );
    if (
      !references?.receipt ||
      !same(
        makeUsDatasetReferenceIdentity(input.references.datasetId, references),
        input.references,
      )
    )
      throw datasetReceivingError("us_dataset_receiving_dependency_conflict", intent.unitKey);
    try {
      await verifyUsDatasetReferences(
        tx,
        context,
        references.intent,
        references.receipt,
        this.stores,
      );
    } catch (cause) {
      if (cause instanceof Error && cause.message === "us_dataset_reference_mismatch")
        throw datasetReceivingError("us_dataset_receiving_mismatch", intent.unitKey, cause);
      throw cause;
    }
    const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
    const bound = (entries: readonly { key: string; id: string }[], key: string) => {
      const matches = entries.filter((entry) => entry.key === key);
      if (matches.length !== 1 || !matches[0]) throw fail();
      return matches[0].id;
    };
    const { tenantId, actorUserId } = context;
    const operationKey = intent.operationKey;
    const operations = schema.receivingOperations;
    if (
      (
        await tx
          .select({ id: operations.operationKey })
          .from(operations)
          .where(and(eq(operations.tenantId, tenantId), eq(operations.operationKey, operationKey)))
          .limit(1)
      ).length
    )
      throw fail();
    const definitions = input.chain.receiving.references.map((number) => {
      const matches = input.chain.documents.filter((d) => d.input.number === number);
      if (matches.length !== 1 || !matches[0]) throw fail();
      return matches[0];
    });
    const sourceId = bound(bindings.locations, input.chain.receiving.previousSourceLocationKey);
    const docs = schema.referenceDocuments;
    for (const definition of definitions) {
      if (
        (
          await tx
            .select({ id: docs.id })
            .from(docs)
            .where(
              and(
                eq(docs.tenantId, tenantId),
                eq(docs.type, definition.input.type),
                eq(docs.number, definition.input.number),
                eq(docs.partyId, bound(bindings.parties, definition.partyKey)),
              ),
            )
            .limit(1)
        ).length
      )
        throw fail();
    }
    const lotTable = schema.traceabilityLots;
    for (const line of input.chain.receiving.lines) {
      if (
        (
          await tx
            .select({ id: lotTable.id })
            .from(lotTable)
            .where(
              and(
                eq(lotTable.tenantId, tenantId),
                eq(lotTable.tlc, line.tlc),
                eq(lotTable.sourceLocationId, sourceId),
              ),
            )
            .limit(1)
        ).length
      )
        throw fail();
    }
    const documents = [];
    for (const definition of definitions)
      documents.push({
        key: definition.key,
        record: await this.stores.documents.createDocumentInTransaction(
          tx,
          tenantId,
          actorUserId,
          { ...definition.input, partyId: bound(bindings.parties, definition.partyKey) },
          operationKey,
        ),
      });
    const draft: ReceivingDraft = {
      dateReceived: input.chain.receiving.eventDate,
      locationId: bound(bindings.locations, input.chain.receiving.receivingLocationKey),
      previousSourceLocationId: sourceId,
      receivedAtNote: null,
      notes: null,
      documentIds: documents.map((d) => d.record.id),
      items: input.chain.receiving.lines.map((line) => ({
        productId: bound(bindings.products, line.productKey),
        lotLinkMode: "create_on_finalize",
        lotId: null,
        tlc: line.tlc,
        source: { kind: "location", locationId: sourceId },
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        exemptSupplier: false,
        exemptReason: null,
        exemptReceipt: null,
        supplierLotReference: null,
        notes: null,
      })),
    };
    const created = await this.stores.receiving.createDraftCommandInTransaction(
      tx,
      tenantId,
      actorUserId,
      { operationKey, draft },
      operationKey,
    );
    if (!("receiptVersion" in created)) throw fail();
    const ready = await this.stores.receiving.checkRevisionReadinessInTransaction(
      tx,
      tenantId,
      actorUserId,
      created.eventId,
      { expectedDraftVersion: created.record.draftVersion },
    );
    if (ready.state !== "complete" || ready.exemptReviewRequiredLines.length !== 0) throw fail();
    const finalized = await this.stores.receiving.finalizeCommandInTransaction(
      tx,
      tenantId,
      actorUserId,
      created.eventId,
      {
        commandVersion: 2,
        operationKey,
        expectedDraftVersion: ready.draftVersion,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: [],
      },
      operationKey,
    );
    if (!("receiptVersion" in finalized) || finalized.record.content.kind !== "finalized")
      throw fail();
    const lots = [];
    for (const line of finalized.record.content.snapshot.items)
      lots.push(await this.stores.lots.getLotInTransaction(tx, tenantId, actorUserId, line.lotId));
    const result = parseUsDatasetReceivingResult({ input, documents, created, finalized, lots });
    return {
      result,
      resultDigest: canonicalExportDigest(result),
      recordIds: usDatasetReceivingRecordIds(result),
    };
  }
}
