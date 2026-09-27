import { schema } from "@markiro/db";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  transformationDraftRecordSchema,
  transformationDraftSchema,
  transformationFinalizedRecordSchema,
  transformationHistoricalRecordSchema,
  type TransformationDraft,
} from "@markiro/platform-contracts";
import { and, asc, eq } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

export const unavailable = () =>
  new ServiceUnavailableException({ code: "us_database_unavailable" });
const events = schema.traceabilityEvents;
export const transformationHeader = (draft: TransformationDraft) => ({
  dateReceived: draft.eventDate,
  locationId: draft.processorLocationId,
  notes: draft.notes,
});

/** Resolve type/tenant before inspecting a typed root. Locks are always root then header. */
export async function readTransformationRecord(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  lock: "share" | "update" = "share",
) {
  const predicate = and(
    eq(events.tenantId, tenantId),
    eq(events.id, eventId),
    eq(events.type, "transformation"),
  );
  const [identity] = await tx
    .select({ id: events.id, rootEventId: events.rootEventId })
    .from(events)
    .where(predicate);
  if (!identity) throw new NotFoundException({ code: "transformation_not_found" });
  const roots = schema.transformationEventRoots;
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, identity.rootEventId)))
    .for(lock);
  const [row] = await tx.select().from(events).where(predicate).for(lock);
  if (
    !row ||
    !root ||
    row.rootEventId !== root.id ||
    (row.revision === 1
      ? row.id !== root.id || row.previousRevisionId !== null
      : row.id === root.id || row.previousRevisionId === null) ||
    root.eventNumber !== row.eventNumber ||
    row.revision >= root.nextRevision
  )
    throw unavailable();
  if (
    (row.status === "draft" && root.pendingDraftId !== row.id) ||
    (row.status === "finalized" && root.currentEventId !== row.id) ||
    (row.status === "amended" && root.currentEventId === row.id) ||
    (row.status === "void" && (root.currentEventId === row.id || root.pendingDraftId === row.id))
  )
    throw unavailable();
  const base = {
    id: row.id,
    eventNumber: row.eventNumber,
    revision: row.revision,
    draftVersion: row.draftVersion,
    timeZone: row.timeZone,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: row.status,
    lifecycle: {
      rootId: root.id,
      lifecycleVersion: root.lifecycleVersion,
      currentEventId: root.currentEventId,
      pendingDraftId: root.pendingDraftId,
      previousRevisionId: row.previousRevisionId,
      amendmentReason: row.amendmentReason,
      supersededByEventId: row.supersededByEventId,
      supersededAt: row.supersededAt?.toISOString() ?? null,
      supersededBy: row.supersededBy,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedBy: row.voidedBy,
      voidReason: row.voidReason,
    },
  };
  if (row.finalizationSnapshot !== null) {
    const parsed = (
      row.status === "finalized"
        ? transformationFinalizedRecordSchema
        : transformationHistoricalRecordSchema
    ).safeParse({
      ...base,
      finalizedAt: row.finalizedAt?.toISOString(),
      finalizedBy: row.finalizedBy,
      snapshot: row.finalizationSnapshot,
    });
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }
  const draft = await readTransformationSavedDraft(tx, tenantId, eventId, row);
  const parsed = (
    row.status === "draft" ? transformationDraftRecordSchema : transformationHistoricalRecordSchema
  ).safeParse({ ...base, draft });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function readTransformationSavedDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  row: typeof events.$inferSelect,
) {
  const details = schema.transformationEventDetails,
    inputs = schema.transformationEventInputs,
    outputs = schema.transformationEventOutputs,
    documents = schema.transformationEventDocuments;
  const [detail] = await tx
    .select()
    .from(details)
    .where(and(eq(details.tenantId, tenantId), eq(details.eventId, eventId)));
  if (!detail) throw unavailable();
  const inputRows = await tx
    .select()
    .from(inputs)
    .where(and(eq(inputs.tenantId, tenantId), eq(inputs.eventId, eventId)))
    .orderBy(asc(inputs.lineNo));
  const outputRows = await tx
    .select()
    .from(outputs)
    .where(and(eq(outputs.tenantId, tenantId), eq(outputs.eventId, eventId)))
    .orderBy(asc(outputs.lineNo));
  const documentRows = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.eventId, eventId)))
    .orderBy(asc(documents.position));
  if (
    inputRows.some((line, i) => line.lineNo !== i + 1) ||
    outputRows.some(
      (line, i) =>
        line.lineNo !== i + 1 ||
        (row.revision === 1 ? line.lotId !== null && row.status === "draft" : line.lotId === null),
    ) ||
    documentRows.some((line, i) => line.position !== i + 1)
  )
    throw unavailable();
  const parsed = transformationDraftSchema.safeParse({
    eventDate: row.dateReceived,
    processorLocationId: row.locationId,
    notes: row.notes,
    reason: detail.reason,
    reasonNote: detail.reasonNote,
    inputs: inputRows.map((line) =>
      line.kind === "ftl_lot"
        ? {
            kind: line.kind,
            lotId: line.lotId,
            quantity: line.quantity,
            unitOfMeasure: line.unitOfMeasure,
          }
        : {
            kind: line.kind,
            productId: line.productId,
            sourceLocationId: line.sourceLocationId,
            reference: line.reference,
            quantity: line.quantity,
            unitOfMeasure: line.unitOfMeasure,
          },
    ),
    outputs: outputRows.map((line) => ({
      productId: line.productId,
      tlc: line.tlc,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
    documentIds: documentRows.map((line) => line.documentId),
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function readTransformationDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  lock: "share" | "update" = "share",
) {
  const record = await readTransformationRecord(tx, tenantId, eventId, lock);
  if (record.status !== "draft") throw new ConflictException({ code: "transformation_not_draft" });
  return record;
}

export async function replaceTransformationChildren(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  draft: TransformationDraft,
  boundOutputLotIds?: readonly string[],
) {
  const details = schema.transformationEventDetails,
    inputs = schema.transformationEventInputs,
    outputs = schema.transformationEventOutputs,
    documents = schema.transformationEventDocuments;
  for (const table of [details, inputs, outputs, documents])
    await tx.delete(table).where(and(eq(table.tenantId, tenantId), eq(table.eventId, eventId)));
  await tx
    .insert(details)
    .values({ tenantId, eventId, reason: draft.reason, reasonNote: draft.reasonNote });
  if (draft.inputs.length)
    await tx
      .insert(inputs)
      .values(draft.inputs.map((line, i) => ({ tenantId, eventId, lineNo: i + 1, ...line })));
  if (draft.outputs.length)
    await tx.insert(outputs).values(
      draft.outputs.map((line, i) => ({
        tenantId,
        eventId,
        lineNo: i + 1,
        ...line,
        lotId: boundOutputLotIds?.[i] ?? null,
      })),
    );
  if (draft.documentIds.length)
    await tx.insert(documents).values(
      draft.documentIds.map((documentId, i) => ({
        tenantId,
        eventId,
        documentId,
        position: i + 1,
      })),
    );
}
