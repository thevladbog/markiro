import { schema } from "@markiro/db";
import {
  shippingDraftSchema,
  shippingHistoricalRecordSchema,
  shippingRevisionListSchema,
  type ShippingHistoricalRecord,
  type ShippingRevisionList,
  type ShippingRevisionListQuery,
} from "@markiro/platform-contracts";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readShippingDraft } from "./us-shipping-draft";
import { readShippingSnapshotRecord } from "./us-shipping-finalization";

const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });
const notFound = () => new NotFoundException({ code: "shipping_not_found" });
const events = schema.traceabilityEvents;
const roots = schema.shippingEventRoots;

/** A historical revision reads its saved child rows or frozen snapshot only. */
export async function readShippingRecord(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<ShippingHistoricalRecord> {
  const [row] = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")));
  if (!row) throw notFound();
  if (row.status === "draft") return readShippingDraft(tx, tenantId, eventId);
  if (row.finalizationSnapshot !== null) return readShippingSnapshotRecord(tx, tenantId, eventId);
  if (row.status !== "void") throw unavailable();
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, row.rootEventId)))
    .for("share");
  const [detail] = await tx
    .select()
    .from(schema.shippingEventDetails)
    .where(
      and(
        eq(schema.shippingEventDetails.tenantId, tenantId),
        eq(schema.shippingEventDetails.eventId, eventId),
      ),
    );
  const itemRows = await tx
    .select()
    .from(schema.shippingEventItems)
    .where(
      and(
        eq(schema.shippingEventItems.tenantId, tenantId),
        eq(schema.shippingEventItems.eventId, eventId),
      ),
    )
    .orderBy(asc(schema.shippingEventItems.lineNo));
  const documentRows = await tx
    .select()
    .from(schema.shippingEventDocuments)
    .where(
      and(
        eq(schema.shippingEventDocuments.tenantId, tenantId),
        eq(schema.shippingEventDocuments.eventId, eventId),
      ),
    )
    .orderBy(asc(schema.shippingEventDocuments.position));
  if (
    !root ||
    !detail ||
    detail.recipientSnapshot !== null ||
    itemRows.some(
      (item, index) =>
        item.lineNo !== index + 1 ||
        item.tlcSnapshot !== null ||
        item.sourceSnapshot !== null ||
        item.productSnapshot !== null,
    ) ||
    documentRows.some((doc, index) => doc.position !== index + 1)
  )
    throw unavailable();
  const draft = shippingDraftSchema.safeParse({
    eventDate: row.dateReceived,
    shipFromLocationId: row.locationId,
    recipientLocationId: detail.recipientLocationId,
    carrierReference: detail.carrierReference,
    notes: row.notes,
    items: itemRows.map((item) => ({
      lotId: item.lotId,
      quantity: item.quantity,
      unitOfMeasure: item.unitOfMeasure,
    })),
    documentIds: documentRows.map((doc) => doc.documentId),
  });
  if (!draft.success) throw unavailable();
  const parsed = shippingHistoricalRecordSchema.safeParse({
    id: row.id,
    eventNumber: row.eventNumber,
    revision: row.revision,
    draftVersion: row.draftVersion,
    timeZone: row.timeZone,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: "void",
    draft: draft.data,
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
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

/** Validate the full root chain before slicing a bounded page. */
export async function readShippingRevisions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  query: ShippingRevisionListQuery,
): Promise<ShippingRevisionList> {
  const [anchor] = await tx
    .select({ rootId: events.rootEventId })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")));
  if (!anchor) throw notFound();
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, anchor.rootId)))
    .for("share");
  if (!root) throw unavailable();
  const rows = await tx
    .select({
      id: events.id,
      rootId: events.rootEventId,
      type: events.type,
      eventNumber: events.eventNumber,
      revision: events.revision,
      status: events.status,
      timeZone: events.timeZone,
      previousRevisionId: events.previousRevisionId,
      amendmentReason: events.amendmentReason,
      voidReason: events.voidReason,
      finalizedAt: events.finalizedAt,
      hasFinalizationSnapshot: sql<boolean>`${events.finalizationSnapshot} IS NOT NULL`,
      supersededByEventId: events.supersededByEventId,
    })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.rootEventId, root.id)))
    .orderBy(asc(events.revision));
  if (
    rows.length !== root.nextRevision - 1 ||
    root.lifecycleVersion !==
      rows.length +
        rows.filter((row) => row.status !== "draft").length +
        rows.filter((row) => row.status === "void" && row.hasFinalizationSnapshot).length ||
    rows[0]?.id !== root.id ||
    !rows.some((row) => row.id === eventId)
  )
    throw unavailable();
  const first = rows[0];
  if (!first) throw unavailable();
  const byId = new Map(rows.map((row) => [row.id, row]));
  let currentCount = 0,
    pendingCount = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (
      !row ||
      row.revision !== index + 1 ||
      row.rootId !== root.id ||
      row.type !== "shipping" ||
      row.eventNumber !== root.eventNumber ||
      row.timeZone !== first.timeZone
    )
      throw unavailable();
    if (index === 0) {
      if (row.previousRevisionId !== null || row.amendmentReason !== null) throw unavailable();
    } else {
      const predecessor = row.previousRevisionId && byId.get(row.previousRevisionId);
      if (
        !predecessor ||
        predecessor.revision >= row.revision ||
        (!["finalized", "amended"].includes(predecessor.status) &&
          !(row.status === "void" && row.finalizedAt === null && predecessor.status === "void")) ||
        row.amendmentReason === null
      )
        throw unavailable();
    }
    if (row.status === "draft") {
      pendingCount++;
      if (
        root.pendingDraftId !== row.id ||
        (row.revision === 1
          ? root.currentEventId !== null
          : root.currentEventId !== row.previousRevisionId)
      )
        throw unavailable();
    } else if (row.status === "finalized") {
      currentCount++;
      if (root.currentEventId !== row.id) throw unavailable();
    } else if (row.status === "amended") {
      const successor = row.supersededByEventId && byId.get(row.supersededByEventId);
      if (
        root.currentEventId === row.id ||
        !successor ||
        successor.previousRevisionId !== row.id ||
        successor.revision <= row.revision
      )
        throw unavailable();
    } else if (row.status === "void") {
      if (
        root.currentEventId === row.id ||
        root.pendingDraftId === row.id ||
        row.voidReason === null
      )
        throw unavailable();
    } else throw unavailable();
  }
  if (
    currentCount !== Number(root.currentEventId !== null) ||
    pendingCount !== Number(root.pendingDraftId !== null)
  )
    throw unavailable();
  const parsed = shippingRevisionListSchema.safeParse({
    items: rows.slice(query.offset, query.offset + query.limit).map((row) => ({
      id: row.id,
      rootId: root.id,
      eventNumber: row.eventNumber,
      revision: row.revision,
      status: row.status,
      timeZone: row.timeZone,
      lifecycleVersion: root.lifecycleVersion,
      currentEventId: root.currentEventId,
      pendingDraftId: root.pendingDraftId,
      previousRevisionId: row.previousRevisionId,
      amendmentReason: row.amendmentReason,
      voidReason: row.voidReason,
    })),
    ...query,
    lifecycleVersion: root.lifecycleVersion,
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
