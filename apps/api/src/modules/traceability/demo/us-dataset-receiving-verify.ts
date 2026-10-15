import { schema } from "@markiro/db";
import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";

import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsCatalogStore } from "../catalog/us-catalog-store.js";
import type { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import type { UsLotStore } from "../lots/us-lot-store.js";
import type { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import type { UsProductProfileStore } from "../products/us-product-profile-store.js";
import type { UsReceivingStore } from "../receiving/us-receiving-store.js";
import { readReceivingSavedInput } from "../receiving/us-receiving-persistence.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  datasetReceivingError,
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingResult,
  usDatasetReceivingLotIdentity,
  usDatasetReceivingRecordIds,
  type UsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { verifyUsDatasetReferencesCore } from "./us-dataset-reference-verify.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetReceivingDependencies } from "./us-dataset-terminal-read-contract.js";
export type UsDatasetReceivingStores = Readonly<{
  journal: UsDatasetJournalStore;
  master: UsMasterDataStore;
  catalog: UsCatalogStore;
  profiles: UsProductProfileStore;
  documents: UsReferenceDocumentStore;
  receiving: UsReceivingStore;
  lots: UsLotStore;
}>;
/** Guarded caller owns the transaction. All locks are retained until its commit. */
export async function verifyUsDatasetReceiving(
  ...args: Parameters<typeof verifyUsDatasetReceivingResult>
): Promise<void> {
  await verifyUsDatasetReceivingResult(...args);
}

/** Returns only the schema-owned value that this exact native invocation checked. */
export async function verifyUsDatasetReceivingResult(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetReceivingStores,
): Promise<UsDatasetReceivingResult> {
  return verifyUsDatasetReceivingResultCore(
    tx,
    context,
    rawIntent,
    rawReceipt,
    freshUsDatasetTerminalDependencies(stores),
  );
}

export async function verifyUsDatasetReceivingResultCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  rawReceipt: UsDatasetReceipt,
  stores: UsDatasetReceivingDependencies,
): Promise<UsDatasetReceivingResult> {
  const intent = parseUsDatasetIntent(rawIntent);
  const receipt = parseUsDemoReceipt(rawReceipt);
  const result = parseUsDatasetReceivingResult(receipt.result);
  const mismatch = (cause?: unknown) =>
    datasetReceivingError("us_dataset_receiving_mismatch", intent.unitKey, cause);
  const equal = (left: unknown, right: unknown) => {
    if (!canonicalExportEqual(left, right)) throw mismatch();
  };
  equal(intent.stage, "receiving");
  equal(intent.unitKey, result.input.chain.unitKey);
  equal(intent.input, result.input);
  equal(result.created.operationKey, intent.operationKey);
  equal(result.finalized.operationKey, intent.operationKey);
  equal(receipt.recordIds, usDatasetReceivingRecordIds(result));
  equal(receipt.resultDigest, canonicalExportDigest(result));
  const { tenantId, actorUserId } = context;
  const rootId = result.created.eventId;
  // Never discover and lock foreign roots through support rows: root -> revisions -> lots.
  const root = await stores.locks.receivingRoot(tx, tenantId, rootId);
  if (!root) throw mismatch();
  equal(
    {
      current: root.currentEventId,
      pending: root.pendingDraftId,
      version: root.lifecycleVersion,
      next: root.nextRevision,
      number: root.eventNumber,
    },
    {
      current: rootId,
      pending: null,
      version: 2,
      next: 2,
      number: result.finalized.record.eventNumber,
    },
  );
  const event = await stores.locks.receivingRevision(tx, tenantId, rootId);
  if (!event) throw mismatch();
  if (result.created.record.content.kind !== "draft") throw mismatch();
  const draft = result.created.record.content.draft;
  equal(
    {
      dateReceived: event.dateReceived,
      locationId: event.locationId,
      previousSourceLocationId: event.previousSourceLocationId,
      receivedAtNote: event.receivedAtNote,
      notes: event.notes,
    },
    {
      dateReceived: draft.dateReceived,
      locationId: draft.locationId,
      previousSourceLocationId: draft.previousSourceLocationId,
      receivedAtNote: draft.receivedAtNote,
      notes: draft.notes,
    },
  );
  const lotIds = result.lots.map(({ id }) => id).sort();
  const owned = await tx
    .select({ id: schema.traceabilityLots.id })
    .from(schema.traceabilityLots)
    .where(
      and(
        eq(schema.traceabilityLots.tenantId, tenantId),
        inArray(schema.traceabilityLots.id, lotIds),
      ),
    )
    .orderBy(asc(schema.traceabilityLots.id))
    .for("update");
  equal(
    owned.map(({ id }) => id),
    lotIds,
  );
  const dependency = result.input.references;
  const referenceStage = await stores.journal.readStageInTransaction(
    tx,
    context,
    dependency.datasetId,
    "references",
    "references",
  );
  if (!referenceStage?.receipt) throw mismatch();
  equal(makeUsDatasetReferenceIdentity(dependency.datasetId, referenceStage), dependency);
  try {
    equal(await readReceivingSavedInput(tx, tenantId, event), {
      ...draft,
      items: draft.items.map((line, index) => ({ ...line, lotId: result.lots[index]?.id })),
    });
    await verifyUsDatasetReferencesCore(
      tx,
      context,
      referenceStage.intent,
      referenceStage.receipt,
      stores,
    );
    const references = parseUsDatasetReferenceResult(referenceStage.receipt.result);
    const binding = (entries: readonly { key: string; id: string }[], key: string) => {
      const found = entries.find((entry) => entry.key === key);
      if (!found) throw mismatch();
      return found.id;
    };
    const lockedDocuments = await stores.locks.receivingDocuments(
      tx,
      tenantId,
      result.documents.map(({ record }) => record.id),
    );
    equal(lockedDocuments.length, 2);
    for (const saved of result.documents) {
      const definition = result.input.chain.documents.find(({ key }) => key === saved.key);
      if (!definition) throw mismatch();
      equal(saved.record.partyId, binding(references.bindings.parties, definition.partyKey));
      equal(
        await stores.documents.getDocumentInTransaction(tx, tenantId, actorUserId, saved.record.id),
        saved.record,
      );
    }
    const final = result.finalized.record;
    if (final.content.kind !== "finalized") throw mismatch();
    const snapshot = final.content.snapshot;
    equal(
      snapshot.locationId,
      binding(references.bindings.locations, result.input.chain.receiving.receivingLocationKey),
    );
    equal(
      snapshot.previousSourceLocationId,
      binding(
        references.bindings.locations,
        result.input.chain.receiving.previousSourceLocationKey,
      ),
    );
    equal(
      await stores.receiving.getLiveRecordInTransaction(tx, tenantId, actorUserId, rootId),
      final,
    );
    for (const [index, saved] of result.lots.entries()) {
      const line = result.input.chain.receiving.lines[index];
      if (!line) throw mismatch();
      equal(saved.productId, binding(references.bindings.products, line.productKey));
      equal(
        usDatasetReceivingLotIdentity(
          await stores.lots.getLotInTransaction(tx, tenantId, actorUserId, saved.id),
        ),
        usDatasetReceivingLotIdentity(saved),
      );
      const { basisVersion: _basisVersion, ...basis } =
        await stores.receiving.getLotReceivingBasisInTransaction(
          tx,
          tenantId,
          actorUserId,
          saved.id,
          { limit: 10, offset: 0 },
        );
      void _basisVersion;
      equal(basis, {
        lotId: saved.id,
        state: "present",
        supportCount: 1,
        items: [
          {
            rootId,
            eventId: rootId,
            eventNumber: final.eventNumber,
            revision: 1,
            lineNos: [index + 1],
          },
        ],
        limit: 10,
        offset: 0,
        hasMore: false,
      });
    }
    const operations = schema.receivingOperations;
    const savedOperations = await tx
      .select()
      .from(operations)
      .where(
        and(eq(operations.tenantId, tenantId), eq(operations.operationKey, intent.operationKey)),
      );
    equal(savedOperations.length, 2);
    for (const command of [result.created, result.finalized]) {
      const row = savedOperations.find(({ command: name }) => name === command.command);
      if (!row) throw mismatch();
      equal(
        {
          tenantId: row.tenantId,
          command: row.command,
          operationKey: row.operationKey,
          inputDigest: row.inputDigest,
          eventId: row.eventId,
          result: row.result,
        },
        {
          tenantId,
          command: command.command,
          operationKey: intent.operationKey,
          inputDigest: command.inputDigest,
          eventId: rootId,
          result: command,
        },
      );
    }
    const audits = schema.tenantAuditEvents;
    const savedAudits = await tx
      .select()
      .from(audits)
      .where(and(eq(audits.organizationId, tenantId), eq(audits.requestId, intent.operationKey)));
    const expectedAudits = [
      ...result.documents.map(({ record }) => ({
        action: "traceability.reference_document.created",
        targetType: "traceability_reference_document",
        targetId: record.id,
        before: null,
        after: record,
      })),
      {
        action: "traceability.receiving.draft_created",
        targetType: "traceability_event",
        targetId: rootId,
        before: null,
        after: result.created.record,
      },
      ...result.lots.map((lot) => ({
        action: "traceability.lot.created",
        targetType: "traceability_lot",
        targetId: lot.id,
        before: null,
        after: { ...lot, eventId: rootId },
      })),
      {
        action: "traceability.receiving.finalized",
        targetType: "traceability_event",
        targetId: rootId,
        before: result.created.record,
        after: {
          rootId,
          revision: 1,
          reason: null,
          result: "finalized",
          effect: null,
          record: final,
          predecessor: null,
          lineLots: {
            before: [],
            after: snapshot.items.map(({ lineNo, lotId }) => ({ lineNo, lotId })),
          },
        },
      },
    ].map((audit) => ({
      ...audit,
      organizationId: tenantId,
      actorUserId,
      outcome: "success",
      requestId: intent.operationKey,
    }));
    const actualAudits = savedAudits.map(
      ({
        organizationId,
        actorUserId: actor,
        action,
        outcome,
        targetType,
        targetId,
        before,
        after,
        requestId,
      }) => ({
        organizationId,
        actorUserId: actor,
        action,
        outcome,
        targetType,
        targetId,
        before,
        after,
        requestId,
      }),
    );
    equal(
      actualAudits.map(canonicalExportDigest).sort(),
      expectedAudits.map(canonicalExportDigest).sort(),
    );
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ServiceUnavailableException ||
      (error instanceof Error &&
        (error.name === "ZodError" || error.message === "us_dataset_reference_mismatch"))
    )
      throw mismatch(error);
    throw error;
  }
  return result;
}
