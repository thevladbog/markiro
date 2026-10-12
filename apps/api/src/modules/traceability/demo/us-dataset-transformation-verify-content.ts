import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import {
  createTransformationDraftSchema,
  finalizeTransformationSchema,
} from "@markiro/platform-contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { readTransformationSavedDraft } from "../transformation/us-transformation-persistence.js";
import { transformationCommandDigest } from "../transformation/us-transformation-operations.js";
import { readCurrentTransformationOrigin } from "../transformation/us-transformation-origin.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { TraceabilityLot } from "@markiro/platform-contracts";
import type { UsDatasetContext, UsDatasetIntent } from "./us-dataset-contract.js";
import type { UsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import type { UsDatasetTransformationEvidence } from "./us-dataset-transformation-content.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";

/** Shared exact native proof; wrappers own dependencies, lock schedule and error translation. */
export async function verifyUsDatasetTransformationContent(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  result: UsDatasetTransformationEvidence,
  bindings: UsDatasetReferenceResult["bindings"],
  inputLots: readonly TraceabilityLot[],
  stores: UsDatasetTransformationStores,
  verifyOutputLot: (current: TraceabilityLot) => Promise<void>,
  mismatch: (cause?: unknown) => Error,
): Promise<void> {
  const { tenantId, actorUserId } = context;
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw mismatch();
  };
  const bound = (entries: readonly { key: string; id: string }[], key: string) => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) throw mismatch();
    return entry.id;
  };
  const rootId = result.created.id;
  const roots = schema.transformationEventRoots,
    events = schema.traceabilityEvents;
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, rootId)));
  if (!root) throw mismatch();
  equal(
    {
      current: root.currentEventId,
      pending: root.pendingDraftId,
      version: root.lifecycleVersion,
      next: root.nextRevision,
      number: root.eventNumber,
    },
    { current: rootId, pending: null, version: 2, next: 2, number: result.finalized.eventNumber },
  );
  const revisions = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.rootEventId, rootId)))
    .orderBy(asc(events.id));
  if (revisions.length !== 1) throw mismatch();
  const event = revisions[0];
  if (
    !event ||
    event.id !== rootId ||
    event.type !== "transformation" ||
    event.status !== "finalized" ||
    event.revision !== 1
  )
    throw mismatch();
  equal(await readTransformationSavedDraft(tx, tenantId, rootId, event), result.createInput.draft);
  equal(
    await stores.transformation.getRecordInTransaction(tx, tenantId, actorUserId, rootId),
    result.finalized,
  );
  equal(result.created.createdBy, actorUserId);
  equal(result.finalized.finalizedBy, actorUserId);
  equal(
    result.finalized.snapshot.processor.id,
    bound(bindings.locations, result.input.chain.transformation.locationKey),
  );
  for (const [i, line] of result.finalized.snapshot.inputs.entries()) {
    const recipe = result.input.chain.transformation.inputs[i];
    const lot = inputLots[i];
    if (
      !recipe ||
      !lot ||
      line.kind !== "ftl_lot" ||
      lot.source?.kind !== "location" ||
      line.source.kind !== "location"
    )
      throw mismatch();
    equal(line.product.id, bound(bindings.products, recipe.productKey));
    equal(line.source.id, lot.source.locationId);
  }
  equal(
    result.outputLot.productId,
    bound(bindings.products, result.input.chain.transformation.output.productKey),
  );
  // Exclude updated clocks and current stock/dependency/basis counters. Consumption
  // mutates those counters but cannot rewrite the originating business identity.
  await verifyOutputLot(
    await stores.lots.getLotInTransaction(tx, tenantId, actorUserId, result.outputLot.id),
  );
  equal(await readCurrentTransformationOrigin(tx, tenantId, result.outputLot.id), {
    lotId: result.outputLot.id,
    currentOrigin: true,
    eventId: rootId,
  });
  const outputs = schema.transformationEventOutputs;
  const outputRows = await tx
    .select({ lineNo: outputs.lineNo, lotId: outputs.lotId })
    .from(outputs)
    .where(and(eq(outputs.tenantId, tenantId), eq(outputs.eventId, rootId)));
  equal(outputRows, [{ lineNo: 1, lotId: result.outputLot.id }]);
  const edges = schema.lotGenealogyEdges;
  const genealogy = await tx
    .select({ inputLotId: edges.inputLotId, outputLotId: edges.outputLotId })
    .from(edges)
    .where(and(eq(edges.tenantId, tenantId), eq(edges.eventId, rootId)))
    .orderBy(asc(edges.inputLotId));
  equal(
    genealogy,
    result.inputLots
      .map((line) => ({ inputLotId: line.lotId, outputLotId: result.outputLot.id }))
      .sort((a, b) => a.inputLotId.localeCompare(b.inputLotId)),
  );
  // Native documents are insertion-only today. Share locks also retain metadata
  // stability through receipt commit if an existing row is corrected externally.
  const docs = schema.referenceDocuments;
  const locked = await tx
    .select({ id: docs.id })
    .from(docs)
    .where(
      and(
        eq(docs.tenantId, tenantId),
        inArray(
          docs.id,
          result.documents.map((d) => d.record.id),
        ),
      ),
    )
    .orderBy(asc(docs.id))
    .for("share");
  equal(locked.length, 2);
  for (const saved of result.documents) {
    const definition = result.input.chain.documents.find((d) => d.key === saved.key);
    if (!definition) throw mismatch();
    equal(saved.record.partyId, bound(bindings.parties, definition.partyKey));
    equal(
      await stores.documents.getDocumentInTransaction(tx, tenantId, actorUserId, saved.record.id),
      saved.record,
    );
  }
  const operations = schema.transformationOperations;
  const savedOperations = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.tenantId, tenantId),
        eq(operations.operationKey, intent.operationKey),
        // Command namespaces are independent: an unrelated root may reuse the
        // UUID for save/amend/void. This stage owns only create/finalize.
        inArray(operations.command, ["transformation.create", "transformation.finalize"]),
      ),
    );
  equal(savedOperations.length, 2);
  // Native digest serializes schema-normalized key order. Historical readiness is
  // retained command evidence; never reconstruct it from mutable current stock.
  for (const [command, input, response] of [
    [
      "transformation.create",
      createTransformationDraftSchema.parse(result.createInput),
      result.created,
    ],
    [
      "transformation.finalize",
      finalizeTransformationSchema.parse(result.finalizeInput),
      result.finalized,
    ],
  ] as const) {
    const row = savedOperations.find((op) => op.command === command);
    if (!row) throw mismatch();
    equal(
      {
        tenantId: row.tenantId,
        command: row.command,
        operationKey: row.operationKey,
        eventId: row.eventId,
        inputDigest: row.inputDigest,
        result: row.result,
      },
      {
        tenantId,
        command,
        operationKey: intent.operationKey,
        eventId: rootId,
        inputDigest: transformationCommandDigest(
          command,
          input,
          command === "transformation.create" ? undefined : rootId,
        ),
        result: response,
      },
    );
  }
  const audit = schema.tenantAuditEvents;
  const savedAudits = await tx
    .select()
    .from(audit)
    .where(and(eq(audit.organizationId, tenantId), eq(audit.requestId, intent.operationKey)));
  // Native operations are DB-trigger immutable; audits are append-only through
  // public commands. All were inserted by this single stage transaction and use
  // PostgreSQL now(). Check clock agreement, not an invented receipt timestamp:
  // the receipt independently retains only service record create/finalize clocks.
  const transactionTime = savedOperations[0]?.createdAt.toISOString();
  if (!transactionTime) throw mismatch();
  for (const row of [...savedOperations, ...savedAudits])
    equal(row.createdAt.toISOString(), transactionTime);
  const expectedAudits = [
    ...result.documents.map(({ record }) => ({
      action: "traceability.reference_document.created",
      targetType: "traceability_reference_document",
      targetId: record.id,
      before: null,
      after: record,
    })),
    {
      action: "traceability.transformation.draft_created",
      targetType: "traceability_event",
      targetId: rootId,
      before: null,
      after: result.created,
    },
    {
      action: "traceability.lot.created",
      targetType: "traceability_lot",
      targetId: result.outputLot.id,
      before: null,
      after: { ...result.outputLot, eventId: rootId },
    },
    {
      action: "traceability.transformation.finalized",
      targetType: "traceability_event",
      targetId: rootId,
      before: result.created,
      after: result.finalized,
    },
  ].map((row) => ({
    ...row,
    organizationId: tenantId,
    actorUserId,
    outcome: "success",
    requestId: intent.operationKey,
  }));
  equal(
    savedAudits
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
        }) =>
          canonicalExportDigest({
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
      .sort(),
    expectedAudits.map(canonicalExportDigest).sort(),
  );
}
