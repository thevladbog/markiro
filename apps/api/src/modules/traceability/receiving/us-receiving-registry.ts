import { schema } from "@markiro/db";
import {
  receivingLiveRecordListSchema,
  type ListReceivingLiveRecordsQuery,
} from "@markiro/platform-contracts";
import { and, desc, eq, getTableColumns, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  escapeLikePattern,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { assertReceivingRootsReadable } from "./us-receiving-chain";
import { receivingRecordIdentity } from "./us-receiving-history";
import { unavailable } from "./us-receiving-persistence";

const events = schema.traceabilityEvents,
  roots = schema.receivingEventRoots,
  items = schema.receivingEventItems,
  documents = schema.receivingEventDocuments;

/** Caller owns the authorized repeatable-read snapshot. Status never expands history. */
export async function readReceivingRegistry(
  tx: UsMasterDataTransaction,
  tenantId: string,
  query: ListReceivingLiveRecordsQuery,
) {
  const pattern = query.search ? `%${escapeLikePattern(query.search)}%` : undefined;
  // Validate complete matching roots before status/page selection. A corrupt
  // chain must not masquerade as an empty or apparently current page.
  await assertReceivingRootsReadable(
    tx,
    tenantId,
    pattern === undefined
      ? sql`true`
      : sql`r.event_number ILIKE ${pattern} OR EXISTS (
          SELECT 1 FROM traceability_events matching
          WHERE matching.tenant_id=r.tenant_id AND matching.root_event_id=r.id
            AND matching.event_number ILIKE ${pattern}
        )`,
  );
  const { finalizationSnapshot, ...columns } = getTableColumns(events);
  void finalizationSnapshot; // Summary reads do not transfer every frozen payload.
  const selected =
    query.history === "all"
      ? undefined
      : or(
          eq(events.id, roots.currentEventId),
          eq(events.id, roots.pendingDraftId),
          and(
            isNull(roots.currentEventId),
            isNull(roots.pendingDraftId),
            eq(events.status, "void"),
            // The last effective receipt may precede a later abandoned draft. Never
            // substitute max(revision), or a canceled amendment will hide that receipt.
            or(isNotNull(events.finalizationSnapshot), eq(events.revision, 1)),
          ),
        );
  const rows = await tx
    .select({
      event: columns,
      root: roots,
      lineCount: sql<number>`(SELECT count(*)::int FROM ${items} WHERE ${items.tenantId}=${events.tenantId} AND ${items.eventId}=${events.id})`,
      documentCount: sql<number>`(SELECT count(*)::int FROM ${documents} WHERE ${documents.tenantId}=${events.tenantId} AND ${documents.eventId}=${events.id})`,
    })
    .from(events)
    .innerJoin(roots, and(eq(roots.tenantId, events.tenantId), eq(roots.id, events.rootEventId)))
    .where(
      and(
        eq(events.tenantId, tenantId),
        eq(events.type, "receiving"),
        selected,
        query.status ? eq(events.status, query.status) : undefined,
        pattern === undefined ? undefined : ilike(events.eventNumber, pattern),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(query.limit)
    .offset(query.offset);
  const result = receivingLiveRecordListSchema.safeParse({
    items: rows.map(({ event, root, lineCount, documentCount }) => ({
      ...receivingRecordIdentity(event, root),
      dateReceived: event.dateReceived,
      locationId: event.locationId,
      previousSourceLocationId: event.previousSourceLocationId,
      lineCount,
      documentCount,
    })),
    limit: query.limit,
    offset: query.offset,
  });
  if (!result.success) throw unavailable();
  return result.data;
}
