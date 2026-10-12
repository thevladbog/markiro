import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { receivingAmendmentDraftSchema, type ReceivingDraft } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import type { UsDatasetAtomicStageWork } from "./us-dataset-atomic-stage-contract.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { verifyUsDatasetReferences } from "./us-dataset-reference-verify.js";
import {
  datasetSpecialError,
  makeUsDatasetSpecialStageIdentity,
  parseUsDatasetSpecialInput,
  parseUsDatasetSpecialResult,
  usDatasetSpecialRecordIds,
} from "./us-dataset-special-contract.js";
import {
  verifyUsDatasetSpecial,
  type UsDatasetSpecialStores,
} from "./us-dataset-special-verify.js";

export async function applyUsDatasetSpecial(
  ...[tx, context, intent, stores]: [
    ...Parameters<UsDatasetAtomicStageWork["apply"]>,
    UsDatasetSpecialStores,
  ]
): ReturnType<UsDatasetAtomicStageWork["apply"]> {
  const input = parseUsDatasetSpecialInput(intent.input);
  const fail = () =>
    datasetSpecialError("us_dataset_special_conflict", intent.unitKey, input.stage);
  const dependency = () =>
    datasetSpecialError("us_dataset_special_dependency_conflict", intent.unitKey, input.stage);
  const same = (a: unknown, b: unknown) => canonicalExportDigest(a) === canonicalExportDigest(b);
  const references = await stores.journal.readStageInTransaction(
    tx,
    context,
    input.references.datasetId,
    "references",
    "references",
  );
  if (
    !references?.receipt ||
    !same(makeUsDatasetReferenceIdentity(input.references.datasetId, references), input.references)
  )
    throw dependency();
  try {
    await verifyUsDatasetReferences(tx, context, references.intent, references.receipt, stores);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "us_dataset_reference_mismatch")
      throw datasetSpecialError("us_dataset_special_mismatch", intent.unitKey, input.stage, cause);
    throw cause;
  }
  const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
  const bound = (entries: readonly { key: string; id: string }[], key: string) => {
    const matches = entries.filter((entry) => entry.key === key);
    if (matches.length !== 1 || !matches[0]) throw fail();
    return matches[0].id;
  };
  const { tenantId, actorUserId } = context;
  const key = intent.operationKey;
  const op = schema.receivingOperations;
  if (
    (
      await tx
        .select({ key: op.operationKey })
        .from(op)
        .where(and(eq(op.tenantId, tenantId), eq(op.operationKey, key)))
        .limit(1)
    ).length
  )
    throw fail();
  const finalize = async (id: string, draftVersion: number) => {
    const ready = await stores.receiving.checkRevisionReadinessInTransaction(
      tx,
      tenantId,
      actorUserId,
      id,
      { expectedDraftVersion: draftVersion },
    );
    if (ready.state !== "complete" || ready.exemptReviewRequiredLines.length !== 0) throw fail();
    const finalized = await stores.receiving.finalizeCommandInTransaction(
      tx,
      tenantId,
      actorUserId,
      id,
      {
        commandVersion: 2,
        operationKey: key,
        expectedDraftVersion: ready.draftVersion,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: [],
      },
      key,
    );
    if (!("receiptVersion" in finalized) || finalized.record.content.kind !== "finalized")
      throw fail();
    return finalized;
  };
  const readLots = async (ids: readonly string[]) => {
    const lots = [];
    for (const id of ids)
      lots.push(await stores.lots.getLotInTransaction(tx, tenantId, actorUserId, id));
    return lots;
  };
  let result;
  if (input.stage === "receiving") {
    const recipe =
      "initialReceiving" in input.recipe ? input.recipe.initialReceiving : input.recipe.receiving;
    const definitions =
      "correctedChain" in input.recipe
        ? input.recipe.correctedChain.documents
        : input.recipe.documents;
    const docs = recipe.references.map((number) => {
      const matches = definitions.filter((definition) => definition.input.number === number);
      if (matches.length !== 1 || !matches[0]) throw fail();
      return matches[0];
    });
    const sourceId = bound(bindings.locations, recipe.previousSourceLocationKey);
    for (const definition of docs) {
      const table = schema.referenceDocuments;
      if (
        (
          await tx
            .select({ id: table.id })
            .from(table)
            .where(
              and(
                eq(table.tenantId, tenantId),
                eq(table.type, definition.input.type),
                eq(table.number, definition.input.number),
                eq(table.partyId, bound(bindings.parties, definition.partyKey)),
              ),
            )
            .limit(1)
        ).length
      )
        throw fail();
    }
    for (const line of recipe.lines) {
      const table = schema.traceabilityLots;
      if (
        (
          await tx
            .select({ id: table.id })
            .from(table)
            .where(
              and(
                eq(table.tenantId, tenantId),
                eq(table.tlc, line.tlc),
                eq(table.sourceLocationId, sourceId),
              ),
            )
            .limit(1)
        ).length
      )
        throw fail();
      const items = schema.receivingEventItems;
      if (
        (
          await tx
            .select({ id: items.eventId })
            .from(items)
            .where(
              and(
                eq(items.tenantId, tenantId),
                eq(items.tlc, line.tlc),
                eq(items.sourceLocationId, sourceId),
              ),
            )
            .limit(1)
        ).length
      )
        throw fail();
    }
    const documents = [];
    for (const definition of docs)
      documents.push({
        key: definition.key,
        record: await stores.documents.createDocumentInTransaction(
          tx,
          tenantId,
          actorUserId,
          { ...definition.input, partyId: bound(bindings.parties, definition.partyKey) },
          key,
        ),
      });
    const draft: ReceivingDraft = {
      dateReceived: recipe.eventDate,
      locationId: bound(bindings.locations, recipe.receivingLocationKey),
      previousSourceLocationId: sourceId,
      receivedAtNote: null,
      notes: null,
      documentIds: documents.map((d) => d.record.id),
      items: recipe.lines.map((line) => ({
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
    const created = await stores.receiving.createDraftCommandInTransaction(
      tx,
      tenantId,
      actorUserId,
      { operationKey: key, draft },
      key,
    );
    if (!("receiptVersion" in created)) throw fail();
    const finalized = await finalize(created.eventId, created.record.draftVersion);
    if (finalized.record.content.kind !== "finalized") throw fail();
    result = parseUsDatasetSpecialResult({
      stage: "receiving",
      input,
      documents,
      created,
      finalized,
      lots: await readLots(finalized.record.content.snapshot.items.map((line) => line.lotId)),
    });
  } else {
    const prior = await stores.journal.readStageInTransaction(
      tx,
      context,
      input.references.datasetId,
      intent.unitKey,
      "receiving",
    );
    if (
      !prior?.receipt ||
      !same(makeUsDatasetSpecialStageIdentity(input.references.datasetId, prior), input.receiving)
    )
      throw dependency();
    await verifyUsDatasetSpecial(tx, context, prior.intent, prior.receipt, stores);
    const original = parseUsDatasetSpecialResult(prior.receipt.result);
    if (original.stage !== "receiving") throw dependency();
    const id = original.finalized.eventId;
    if (input.stage === "void_receiving") {
      if (!("voidReason" in input.recipe)) throw fail();
      const voided = await stores.receiving.voidInTransaction(
        tx,
        tenantId,
        actorUserId,
        id,
        {
          commandVersion: 2,
          operationKey: key,
          expectedLifecycleVersion: original.finalized.record.lifecycle.lifecycleVersion,
          expectedDraftVersion: null,
          reason: input.recipe.voidReason,
        },
        key,
      );
      result = parseUsDatasetSpecialResult({
        stage: "void_receiving",
        input,
        original,
        voided,
        lots: await readLots(original.lots.map((l) => l.id)),
      });
    } else {
      if (!("amendmentReason" in input.recipe)) throw fail();
      const started = await stores.receiving.amendInTransaction(
        tx,
        tenantId,
        actorUserId,
        id,
        {
          commandVersion: 2,
          operationKey: key,
          expectedLifecycleVersion: original.finalized.record.lifecycle.lifecycleVersion,
          reason: input.recipe.amendmentReason,
        },
        key,
      );
      if (started.record.content.kind !== "draft") throw fail();
      const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
      const first = draft.items[0];
      if (!first) throw fail();
      first.quantity = "300";
      const saved = await stores.receiving.saveAmendmentInTransaction(
        tx,
        tenantId,
        actorUserId,
        started.eventId,
        {
          commandVersion: 2,
          operationKey: key,
          expectedLifecycleVersion: started.record.lifecycle.lifecycleVersion,
          expectedDraftVersion: started.record.draftVersion,
          draft,
        },
        key,
      );
      const finalized = await finalize(saved.eventId, saved.record.draftVersion);
      const predecessor = await stores.receiving.getLiveRecordInTransaction(
        tx,
        tenantId,
        actorUserId,
        id,
      );
      result = parseUsDatasetSpecialResult({
        stage: "amend_receiving",
        input,
        original,
        started,
        saved,
        finalized,
        predecessor,
        lots: await readLots(original.lots.map((l) => l.id)),
      });
    }
  }
  return {
    result,
    resultDigest: canonicalExportDigest(result),
    recordIds: usDatasetSpecialRecordIds(result),
  };
}
