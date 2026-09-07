import { NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import {
  receivingLiveRecordSchema,
  receivingRevisionListSchema,
  type ReceivingRevisionListQuery,
} from "@markiro/platform-contracts";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingSavedInput, unavailable } from "./us-receiving-persistence";
import type { ReceivingRootRow } from "./us-receiving-roots";
import { assertReceivingRootsReadable } from "./us-receiving-chain";

const events = schema.traceabilityEvents,
  roots = schema.receivingEventRoots;
type Header = typeof events.$inferSelect;

async function readRoot(tx: UsMasterDataTransaction, tenantId: string, id: string) {
  const [anchor] = await tx
    .select({ rootId: events.rootEventId, number: events.eventNumber, type: events.type })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, id)));
  if (!anchor) throw new NotFoundException({ code: "receiving_draft_not_found" });
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, anchor.rootId)));
  if (!root || anchor.type !== "receiving" || root.eventNumber !== anchor.number)
    throw unavailable();
  await assertReceivingRootsReadable(tx, tenantId, sql`r.id=${root.id}`);
  return root;
}

export function receivingRecordIdentity(
  header: Omit<Header, "finalizationSnapshot">,
  root: ReceivingRootRow,
) {
  return {
    recordVersion: 2,
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
    lifecycle: {
      rootId: root.id,
      lifecycleVersion: root.lifecycleVersion,
      previousRevisionId: header.previousRevisionId,
      supersededByEventId: header.supersededByEventId,
      currentEventId: root.currentEventId,
      pendingDraftId: root.pendingDraftId,
      amendmentReason: header.amendmentReason,
      supersededAt: header.supersededAt?.toISOString() ?? null,
      supersededBy: header.supersededBy,
      voidedAt: header.voidedAt?.toISOString() ?? null,
      voidedBy: header.voidedBy,
      voidReason: header.voidReason,
    },
  };
}

/** Caller owns the authorized repeatable-read snapshot. No live master labels are fetched. */
export async function readReceivingLiveRecord(
  tx: UsMasterDataTransaction,
  tenantId: string,
  id: string,
) {
  const root = await readRoot(tx, tenantId, id);
  const [header] = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, id)));
  if (!header) throw unavailable();
  const parsed = receivingLiveRecordSchema.safeParse({
    ...receivingRecordIdentity(header, root),
    content:
      header.finalizationSnapshot === null
        ? { kind: "draft", draft: await readReceivingSavedInput(tx, tenantId, header) }
        : {
            kind: "finalized",
            finalizedAt: header.finalizedAt?.toISOString(),
            finalizedBy: header.finalizedBy,
            snapshot: header.finalizationSnapshot,
          },
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function readReceivingRevisions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  id: string,
  query: ReceivingRevisionListQuery,
) {
  const root = await readRoot(tx, tenantId, id);
  const { finalizationSnapshot, ...columns } = getTableColumns(events);
  void finalizationSnapshot; // History pages do not load every frozen payload.
  const items = schema.receivingEventItems,
    documents = schema.receivingEventDocuments;
  const rows = await tx
    .select({
      ...columns,
      lineCount: sql<number>`(SELECT count(*)::int FROM ${items} WHERE ${items.tenantId}=${events.tenantId} AND ${items.eventId}=${events.id})`,
      documentCount: sql<number>`(SELECT count(*)::int FROM ${documents} WHERE ${documents.tenantId}=${events.tenantId} AND ${documents.eventId}=${events.id})`,
    })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.rootEventId, root.id)))
    .orderBy(asc(events.revision))
    .limit(query.limit)
    .offset(query.offset);
  const parsed = receivingRevisionListSchema.safeParse({
    items: rows.map((row) => ({
      ...receivingRecordIdentity(row, root),
      dateReceived: row.dateReceived,
      locationId: row.locationId,
      previousSourceLocationId: row.previousSourceLocationId,
      lineCount: row.lineCount,
      documentCount: row.documentCount,
    })),
    ...query,
    lifecycleVersion: root.lifecycleVersion,
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
