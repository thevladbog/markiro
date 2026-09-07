import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { schema } from "@markiro/db";
import {
  receivingDraftRecordSchema,
  receivingFinalizedRecordSchema,
  type ReceivingDraft,
  type ReceivingDraftRecord,
} from "@markiro/platform-contracts";
import { and, asc, eq } from "drizzle-orm";
import { lotSourceColumns } from "../lots/us-lot-support";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

const events = schema.traceabilityEvents,
  items = schema.receivingEventItems,
  documents = schema.receivingEventDocuments;
export const unavailable = () =>
  new ServiceUnavailableException({ code: "us_database_unavailable" });
export function parseReceivingRecord(value: unknown): ReceivingDraftRecord {
  const result = receivingDraftRecordSchema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}

/** The header lock prevents a read spanning two full-replacement commits. */
export async function readReceivingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  id: string,
  lock: "share" | "update",
) {
  const result = await readReceivingRecord(tx, tenantId, id, lock);
  if (result.status !== "draft")
    throw new ConflictException({ code: "receiving_already_finalized" });
  return result;
}

export async function readReceivingRecord(
  tx: UsMasterDataTransaction,
  tenantId: string,
  id: string,
  lock: "share" | "update",
) {
  const [header] = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, id)))
    .for(lock);
  if (!header) throw new NotFoundException({ code: "receiving_draft_not_found" });
  if (header.type !== "receiving") throw unavailable();
  const metadata = {
    id: header.id,
    eventNumber: header.eventNumber,
    status: header.status,
    revision: header.revision,
    draftVersion: header.draftVersion,
    timeZone: header.timeZone,
    createdBy: header.createdBy,
    updatedBy: header.updatedBy,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
  };
  if (header.status === "finalized") {
    const frozen = receivingFinalizedRecordSchema.safeParse({
      ...metadata,
      finalizedAt: header.finalizedAt?.toISOString(),
      finalizedBy: header.finalizedBy,
      snapshot: header.finalizationSnapshot,
    });
    if (!frozen.success) throw unavailable();
    return frozen.data;
  }
  return parseReceivingRecord({
    ...metadata,
    draft: await readReceivingSavedInput(tx, tenantId, header),
  });
}

/** Saved child projection only; caller validates the versioned original/live envelope. */
export async function readReceivingSavedInput(
  tx: UsMasterDataTransaction,
  tenantId: string,
  header: typeof events.$inferSelect,
) {
  const id = header.id;
  const lines = await tx
    .select()
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.eventId, id)))
    .orderBy(asc(items.lineNo));
  const links = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.eventId, id)))
    .orderBy(asc(documents.position));
  if (
    lines.some((row, index) => row.lineNo !== index + 1) ||
    links.some((row, index) => row.position !== index + 1)
  )
    throw unavailable();
  return {
    dateReceived: header.dateReceived,
    locationId: header.locationId,
    previousSourceLocationId: header.previousSourceLocationId,
    receivedAtNote: header.receivedAtNote,
    notes: header.notes,
    documentIds: links.map((row) => row.documentId),
    items: lines.map((row) => {
      let source: unknown = null;
      if (row.sourceLocationId !== null) {
        if (
          row.sourceReferenceKind !== null ||
          row.sourceReferenceValue !== null ||
          row.sourceReferenceLocationId !== null
        )
          throw unavailable();
        source = { kind: "location", locationId: row.sourceLocationId };
      } else if (
        row.sourceReferenceKind !== null ||
        row.sourceReferenceValue !== null ||
        row.sourceReferenceLocationId !== null
      ) {
        source = {
          kind: "reference",
          referenceKind: row.sourceReferenceKind,
          referenceValue: row.sourceReferenceValue,
          resolvedLocationId: row.sourceReferenceLocationId,
        };
      }
      return {
        ...(header.revision > 1 ? { previousLineNo: row.previousLineNo } : {}),
        productId: row.productId,
        lotLinkMode: row.lotLinkMode,
        lotId: row.lotId,
        tlc: row.tlc,
        source,
        exemptSupplier: row.exemptSupplier,
        exemptReason: row.exemptReason,
        exemptReceipt: row.exemptReceipt ?? null,
        supplierLotReference: row.supplierLotReference,
        quantity: row.quantity,
        unitOfMeasure: row.unitOfMeasure,
        notes: row.notes,
      };
    }),
  };
}

export function receivingHeader(
  draft: Pick<
    ReceivingDraft,
    "dateReceived" | "locationId" | "previousSourceLocationId" | "receivedAtNote" | "notes"
  >,
) {
  return {
    dateReceived: draft.dateReceived,
    locationId: draft.locationId,
    previousSourceLocationId: draft.previousSourceLocationId,
    receivedAtNote: draft.receivedAtNote,
    notes: draft.notes,
  };
}

export async function replaceReceivingChildren(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  draft: ReceivingDraft,
) {
  await tx.delete(items).where(and(eq(items.tenantId, tenantId), eq(items.eventId, eventId)));
  await tx
    .delete(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.eventId, eventId)));
  if (draft.items.length)
    await tx.insert(items).values(
      draft.items.map(({ source, ...row }, index) => ({
        ...row,
        exemptReceipt: row.exemptReceipt ?? null,
        ...lotSourceColumns(source),
        tenantId,
        eventId,
        lineNo: index + 1,
      })),
    );
  if (draft.documentIds.length)
    await tx.insert(documents).values(
      draft.documentIds.map((documentId, index) => ({
        tenantId,
        eventId,
        documentId,
        position: index + 1,
      })),
    );
}
