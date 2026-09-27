import {
  usTraceHistoryCursorSchema,
  usTraceHistoryPageSchema,
  usTraceHistoryQuerySchema,
  type UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import { assertTraceRelations, traceRelations } from "./us-trace-query";

/** Shared complement of the current-root predicate; EXISTS counts revisions, not child lines. */
function excludedRevisions(tenantId: string) {
  return sql`FROM traceability_events e
    JOIN roots r ON r.id=e.root_event_id AND r.type=e.type
    WHERE e.tenant_id=${tenantId}
      AND EXISTS (SELECT 1 FROM children c WHERE c.event_id=e.id AND c.type=e.type)
      AND (NOT (r.current_event_id=e.id AND e.status='finalized' AND e.superseded_by_event_id IS NULL)
        OR r.current_event_id IS NULL)`;
}

export async function countExcludedTraceRevisions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  visibleLotIds: readonly string[],
): Promise<number> {
  if (visibleLotIds.length > 500) throw unavailable();
  if (!visibleLotIds.length) return 0;
  await assertTraceRelations(tx, tenantId, visibleLotIds);
  const result = await tx.execute<{ count: string }>(sql`${traceRelations(tenantId, visibleLotIds)}
    SELECT count(DISTINCT e.id)::text AS count ${excludedRevisions(tenantId)}`);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw unavailable();
  return count;
}

export function parseTraceHistoryQuery(query: unknown) {
  const request = parseMasterDataInput(usTraceHistoryQuerySchema, query);
  if (!request.cursor) return { ...request, after: null };
  try {
    const bytes = Buffer.from(request.cursor, "base64url");
    if (bytes.toString("base64url") !== request.cursor) throw new Error("Noncanonical cursor");
    const after = parseMasterDataInput(
      usTraceHistoryCursorSchema,
      JSON.parse(bytes.toString("utf8")),
    );
    return { ...request, after };
  } catch {
    throw new BadRequestException({ code: "invalid_trace_history_cursor" });
  }
}

export async function readTraceHistory(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  request: ReturnType<typeof parseTraceHistoryQuery>,
): Promise<UsTraceHistoryPage> {
  await assertTraceRelations(tx, tenantId, [lotId]);
  const after = request.after;
  const result = await tx.execute<
    UsTraceHistoryPage["items"][number]
  >(sql`${traceRelations(tenantId, [lotId])}
    SELECT e.id AS "eventId",e.root_event_id AS "rootId",e.type,e.event_number AS "eventNumber",
      e.revision,e.status,CASE WHEN e.status='void' THEN e.void_reason ELSE e.amendment_reason END AS reason,
      e.previous_revision_id AS "previousRevisionId",e.superseded_by_event_id AS "nextRevisionId",
      e.event_date::text AS "eventDate",
      to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    ${excludedRevisions(tenantId)}
    ${after ? sql`AND (e.created_at,e.id) > (${after.createdAt}::timestamptz,${after.eventId}::uuid)` : sql``}
    ORDER BY e.created_at,e.id LIMIT ${request.limit + 1}`);
  const items = result.rows.slice(0, request.limit);
  const last = items.at(-1);
  const nextCursor =
    result.rows.length > request.limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, eventId: last.eventId })).toString(
          "base64url",
        )
      : null;
  const parsed = usTraceHistoryPageSchema.safeParse({ items, nextCursor });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
