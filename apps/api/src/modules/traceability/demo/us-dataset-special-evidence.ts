import { schema } from "@markiro/db";
import {
  canonicalExportDigest,
  classifyReceivingAmendment,
  type ReceivingMaterialRevision,
} from "@markiro/domain";
import type { ReceivingLiveRecord, ReceivingOperationReceiptV2 } from "@markiro/platform-contracts";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { readReceivingSavedInput } from "../receiving/us-receiving-persistence.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { verifyUsDatasetReferences } from "./us-dataset-reference-verify.js";
import {
  datasetSpecialError,
  type UsDatasetSpecialLifecycleResult,
  type UsDatasetSpecialReceivingResult,
} from "./us-dataset-special-contract.js";
import type { UsDatasetSpecialStores } from "./us-dataset-special-verify.js";

export function specialEqual(
  a: unknown,
  b: unknown,
  original: UsDatasetSpecialReceivingResult,
): void {
  if (canonicalExportDigest(a) !== canonicalExportDigest(b))
    throw datasetSpecialError(
      "us_dataset_special_mismatch",
      original.input.kind === "correction" ? "correction_0001" : "orphan_0001",
      "receiving",
    );
}
/** A historical record projected at amendment-finalize time, before the root transition. */
function predecessorBefore(
  result: Extract<UsDatasetSpecialLifecycleResult, { stage: "amend_receiving" }>,
): ReceivingLiveRecord {
  const original = result.original.finalized.record;
  return {
    ...original,
    lifecycle: {
      ...original.lifecycle,
      lifecycleVersion: result.saved.record.lifecycle.lifecycleVersion,
      pendingDraftId: result.saved.eventId,
    },
  };
}
function material(record: ReceivingLiveRecord): ReceivingMaterialRevision {
  if (record.content.kind !== "finalized") throw new Error("us_dataset_special_result_invalid");
  const snapshot = record.content.snapshot;
  if (snapshot.snapshotVersion !== 3) throw new Error("us_dataset_special_result_invalid");
  return {
    dateReceived: snapshot.dateReceived,
    locationId: snapshot.locationId,
    previousSourceLocationId: snapshot.previousSourceLocationId,
    lines: snapshot.items.map((line) => ({
      lineNo: line.lineNo,
      previousLineNo: line.lotBinding.kind === "retained" ? line.lotBinding.previousLineNo : null,
      lotId: line.lotId,
      productId: line.productId,
      lotLinkMode: line.lotLinkMode,
      effectiveTlc: line.tlc,
      source: line.source,
      receiptHandling: line.receiptBasis.kind,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
  };
}
function mapping(record: ReceivingLiveRecord) {
  if (record.content.kind !== "finalized") throw new Error("us_dataset_special_result_invalid");
  return record.content.snapshot.items.map(({ lineNo, lotId }) => ({ lineNo, lotId }));
}
export async function verifySpecialOperationsAndAudits(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  original: UsDatasetSpecialReceivingResult,
  lifecycle: UsDatasetSpecialLifecycleResult | null,
): Promise<void> {
  const equal = (a: unknown, b: unknown) => specialEqual(a, b, original);
  const rootId = original.created.eventId;
  const final = original.finalized.record;
  type AuditEvidence = Readonly<{
    action: string;
    targetType: string;
    targetId: string;
    before: unknown;
    after: unknown;
  }>;
  const initial: readonly AuditEvidence[] = [
    ...original.documents.map(({ record }) => ({
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
      after: original.created.record,
    },
    ...original.lots.map((lot) => ({
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
      before: original.created.record,
      after: {
        rootId,
        revision: 1,
        reason: null,
        result: "finalized",
        effect: null,
        record: final,
        predecessor: null,
        lineLots: { before: [], after: mapping(final) },
      },
    },
  ];
  const groups: { commands: ReceivingOperationReceiptV2[]; audits: readonly AuditEvidence[] }[] = [
    { commands: [original.created, original.finalized], audits: initial },
  ];
  if (lifecycle?.stage === "void_receiving")
    groups.push({
      commands: [lifecycle.voided],
      audits: [
        {
          action: "traceability.receiving.voided",
          targetType: "traceability_event",
          targetId: rootId,
          before: final,
          after: {
            rootId,
            revision: 1,
            reason: lifecycle.voided.record.lifecycle.voidReason,
            result: "voided",
            record: lifecycle.voided.record,
          },
        },
      ],
    });
  if (lifecycle?.stage === "amend_receiving") {
    const { started, saved, finalized, predecessor } = lifecycle;
    groups.push({
      commands: [started, saved, finalized],
      audits: [
        {
          action: "traceability.receiving.amendment_started",
          targetType: "traceability_event",
          targetId: started.eventId,
          before: final,
          after: {
            rootId,
            revision: 2,
            reason: started.record.lifecycle.amendmentReason,
            result: "draft_started",
            record: started.record,
          },
        },
        {
          action: "traceability.receiving.draft_saved",
          targetType: "traceability_event",
          targetId: saved.eventId,
          before: started.record,
          after: saved.record,
        },
        {
          action: "traceability.receiving.finalized",
          targetType: "traceability_event",
          targetId: finalized.eventId,
          before: saved.record,
          after: {
            rootId,
            revision: 2,
            reason: finalized.record.lifecycle.amendmentReason,
            result: "finalized",
            effect: classifyReceivingAmendment(material(final), material(finalized.record)),
            record: finalized.record,
            predecessor: { before: predecessorBefore(lifecycle), after: predecessor },
            lineLots: { before: mapping(final), after: mapping(finalized.record) },
          },
        },
      ],
    });
  }
  for (const group of groups) {
    const key = group.commands[0]?.operationKey;
    if (!key) throw new Error("us_dataset_special_result_invalid");
    const op = schema.receivingOperations;
    const operations = await tx
      .select()
      .from(op)
      .where(and(eq(op.tenantId, context.tenantId), eq(op.operationKey, key)));
    equal(
      operations
        .map(({ tenantId, command, operationKey, inputDigest, eventId, result }) => ({
          tenantId,
          command,
          operationKey,
          inputDigest,
          eventId,
          result,
        }))
        .map(canonicalExportDigest)
        .sort(),
      group.commands
        .map((command) => ({
          tenantId: context.tenantId,
          command: command.command,
          operationKey: key,
          inputDigest: command.inputDigest,
          eventId: command.eventId,
          result: command,
        }))
        .map(canonicalExportDigest)
        .sort(),
    );
    const audits = schema.tenantAuditEvents;
    const rows = await tx
      .select()
      .from(audits)
      .where(and(eq(audits.organizationId, context.tenantId), eq(audits.requestId, key)));
    equal(
      rows
        .map(
          ({
            organizationId,
            actorUserId,
            action,
            outcome,
            targetType,
            targetId,
            before,
            after,
            requestId,
          }) => ({
            organizationId,
            actorUserId,
            action,
            outcome,
            targetType,
            targetId,
            before,
            after,
            requestId,
          }),
        )
        .map(canonicalExportDigest)
        .sort(),
      group.audits
        .map((audit) => ({
          ...audit,
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          outcome: "success",
          requestId: key,
        }))
        .map(canonicalExportDigest)
        .sort(),
    );
  }
}
export async function verifySpecialBindings(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  original: UsDatasetSpecialReceivingResult,
  lifecycle: UsDatasetSpecialLifecycleResult | null,
  revisions: readonly (typeof schema.traceabilityEvents.$inferSelect)[],
  stores: UsDatasetSpecialStores,
): Promise<void> {
  const equal = (a: unknown, b: unknown) => specialEqual(a, b, original);
  const { tenantId, actorUserId } = context;
  const dependency = original.input.references;
  const reference = await stores.journal.readStageInTransaction(
    tx,
    context,
    dependency.datasetId,
    "references",
    "references",
  );
  if (!reference?.receipt)
    throw datasetSpecialError("us_dataset_special_mismatch", "references", "receiving");
  equal(makeUsDatasetReferenceIdentity(dependency.datasetId, reference), dependency);
  await verifyUsDatasetReferences(tx, context, reference.intent, reference.receipt, stores);
  const bindings = parseUsDatasetReferenceResult(reference.receipt.result).bindings;
  const bound = (entries: readonly { key: string; id: string }[], key: string) =>
    entries.find((e) => e.key === key)?.id;
  const recipe =
    "initialReceiving" in original.input.recipe
      ? original.input.recipe.initialReceiving
      : original.input.recipe.receiving;
  const definitions =
    "correctedChain" in original.input.recipe
      ? original.input.recipe.correctedChain.documents
      : original.input.recipe.documents;
  const docs = schema.referenceDocuments;
  equal(
    (
      await tx
        .select({ id: docs.id })
        .from(docs)
        .where(
          and(
            eq(docs.tenantId, tenantId),
            inArray(
              docs.id,
              original.documents.map((d) => d.record.id),
            ),
          ),
        )
        .orderBy(asc(docs.id))
        .for("share")
    ).length,
    2,
  );
  for (const saved of original.documents) {
    const definition = definitions.find((d) => d.key === saved.key);
    equal(saved.record.partyId, bound(bindings.parties, definition?.partyKey ?? ""));
    equal(
      await stores.documents.getDocumentInTransaction(tx, tenantId, actorUserId, saved.record.id),
      saved.record,
    );
  }
  if (
    original.created.record.content.kind !== "draft" ||
    original.finalized.record.content.kind !== "finalized"
  )
    throw new Error("us_dataset_special_result_invalid");
  const draft = original.created.record.content.draft;
  equal(draft.locationId, bound(bindings.locations, recipe.receivingLocationKey));
  equal(
    draft.previousSourceLocationId,
    bound(bindings.locations, recipe.previousSourceLocationKey),
  );
  const originalRow = revisions.find((e) => e.id === original.created.eventId);
  if (!originalRow) throw new Error("us_dataset_special_mismatch");
  equal(await readReceivingSavedInput(tx, tenantId, originalRow), {
    ...draft,
    items: draft.items.map((line, i) => ({ ...line, lotId: original.lots[i]?.id })),
  });
  if (lifecycle?.stage === "amend_receiving") {
    const row = revisions.find((e) => e.id === lifecycle.saved.eventId);
    if (!row || lifecycle.saved.record.content.kind !== "draft")
      throw new Error("us_dataset_special_mismatch");
    equal(await readReceivingSavedInput(tx, tenantId, row), lifecycle.saved.record.content.draft);
  }
  const current =
    lifecycle?.stage === "amend_receiving" ? lifecycle.finalized.record : original.finalized.record;
  for (const [index, lot] of original.lots.entries()) {
    equal(lot.productId, bound(bindings.products, recipe.lines[index]?.productKey ?? ""));
    // Native DTOs omit basis/dependency epochs; every returned business/provenance field remains bound.
    equal(await stores.lots.getLotInTransaction(tx, tenantId, actorUserId, lot.id), lot);
    if (lifecycle) equal(lifecycle.lots[index], lot);
    const { basisVersion, ...basis } = await stores.receiving.getLotReceivingBasisInTransaction(
      tx,
      tenantId,
      actorUserId,
      lot.id,
      { limit: 10, offset: 0 },
    );
    void basisVersion;
    const absent = lifecycle?.stage === "void_receiving";
    equal(basis, {
      lotId: lot.id,
      state: absent ? "missing" : "present",
      supportCount: absent ? 0 : 1,
      items: absent
        ? []
        : [
            {
              rootId: original.created.eventId,
              eventId: current.id,
              eventNumber: current.eventNumber,
              revision: current.revision,
              lineNos: [index + 1],
            },
          ],
      limit: 10,
      offset: 0,
      hasMore: false,
    });
  }
  if (lifecycle?.stage === "void_receiving") {
    // This fixed orphan recipe never enters another event or case chain. Current
    // consumer filtering would miss draft/history links and additional origins.
    // The joint verifier already holds both owned lot locks through commit.
    const lotIds = original.lots.map(({ id }) => id);
    for (const table of [
      schema.transformationEventInputs,
      schema.transformationEventOutputs,
      schema.shippingEventItems,
      schema.traceLotBoxes,
    ]) {
      const support = await tx
        .select({ lotId: table.lotId })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), inArray(table.lotId, lotIds)))
        .limit(1);
      equal(support.length, 0);
    }
    const edges = schema.lotGenealogyEdges;
    const genealogy = await tx
      .select({ eventId: edges.eventId })
      .from(edges)
      .where(
        and(
          eq(edges.tenantId, tenantId),
          or(inArray(edges.inputLotId, lotIds), inArray(edges.outputLotId, lotIds)),
        ),
      )
      .limit(1);
    equal(genealogy.length, 0);
  }
}
