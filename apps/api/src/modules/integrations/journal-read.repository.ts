import { schema, type Db } from "@markiro/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { IntegrationChannelType } from "./channel-registry.js";
import type { JournalEventDto, JournalPageDto, JournalSessionDto } from "./dto.js";
import {
  JOURNAL_ITEM_EVENTS_PER_SESSION_LIMIT,
  type ResolvedJournalQuery,
} from "./journal-query.js";

type JournalTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface JournalRow extends Record<string, unknown> {
  id: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  outcome: string | null;
  summary: Record<string, unknown> | null;
  orphan: boolean;
  eventAt: Date | string | null;
  eventDirection: string | null;
  eventOutcome: string | null;
  eventMessage: string | null;
  eventDetails: Record<string, unknown> | null;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  sessionId: string;
  at: Date | string;
  direction: string;
  outcome: string;
  message: string;
  details: Record<string, unknown> | null;
}

function sessionOutcomePredicate(query: ResolvedJournalQuery): SQL {
  if (query.outcome === "all") return sql`true`;
  if (query.outcome === "running") return sql`integration_session.outcome is null`;
  return sql`integration_session.outcome = ${query.outcome}`;
}

function orphanOutcomePredicate(query: ResolvedJournalQuery): SQL {
  if (query.outcome === "all") return sql`true`;
  if (query.outcome === "running") return sql`false`;
  return sql`orphan_event.outcome = ${query.outcome}`;
}

function sessionDirectionPredicate(
  tenantId: string,
  type: IntegrationChannelType,
  query: ResolvedJournalQuery,
): SQL {
  if (query.direction === "all") return sql`true`;
  return sql`exists (
    select 1
    from integration_events direction_event
    where direction_event.tenant_id = ${tenantId}
      and direction_event.channel_type = ${type}
      and direction_event.session_id = integration_session.id
      and direction_event.direction = ${query.direction}
  )`;
}

function orphanDirectionPredicate(query: ResolvedJournalQuery): SQL {
  if (query.direction === "all") return sql`true`;
  return sql`orphan_event.direction = ${query.direction}`;
}

function journalUpperBound(query: ResolvedJournalQuery): SQL {
  return query.toIsImplicit ? sql`current_timestamp` : sql`${query.to}`;
}

function journalRows(
  tenantId: string,
  type: IntegrationChannelType,
  query: ResolvedJournalQuery,
): SQL {
  return sql`
    select
      integration_session.id as "id",
      integration_session.started_at as "startedAt",
      integration_session.finished_at as "finishedAt",
      integration_session.outcome as "outcome",
      integration_session.summary as "summary",
      false as "orphan",
      null::timestamptz as "eventAt",
      null::text as "eventDirection",
      null::text as "eventOutcome",
      null::text as "eventMessage",
      null::jsonb as "eventDetails"
    from integration_sessions integration_session
    where integration_session.tenant_id = ${tenantId}
      and integration_session.channel_type = ${type}
      and integration_session.started_at >= ${query.from}
      and integration_session.started_at <= ${journalUpperBound(query)}
      and ${sessionOutcomePredicate(query)}
      and ${sessionDirectionPredicate(tenantId, type, query)}

    union all

    select
      orphan_event.id as "id",
      orphan_event.at as "startedAt",
      orphan_event.at as "finishedAt",
      orphan_event.outcome as "outcome",
      null::jsonb as "summary",
      true as "orphan",
      orphan_event.at as "eventAt",
      orphan_event.direction as "eventDirection",
      orphan_event.outcome as "eventOutcome",
      orphan_event.message as "eventMessage",
      orphan_event.details as "eventDetails"
    from integration_events orphan_event
    where orphan_event.tenant_id = ${tenantId}
      and orphan_event.channel_type = ${type}
      and orphan_event.session_id is null
      and orphan_event.at >= ${query.from}
      and orphan_event.at <= ${journalUpperBound(query)}
      and ${orphanOutcomePredicate(query)}
      and ${orphanDirectionPredicate(query)}
  `;
}

function toEventDto(row: EventRow): JournalEventDto {
  return {
    at: asIsoTimestamp(row.at, "event timestamp"),
    direction: row.direction,
    outcome: row.outcome,
    message: row.message,
    details: row.details,
  };
}

function orphanSession(row: JournalRow): JournalSessionDto {
  if (
    row.eventAt === null ||
    row.eventDirection === null ||
    row.eventOutcome === null ||
    row.eventMessage === null
  ) {
    throw new Error(`Orphan journal row ${row.id} is missing its event payload`);
  }
  return {
    id: row.id,
    startedAt: asIsoTimestamp(row.startedAt, "orphan event timestamp"),
    finishedAt:
      row.finishedAt === null
        ? null
        : asIsoTimestamp(row.finishedAt, "orphan event finish timestamp"),
    outcome: row.outcome,
    summary: row.summary,
    eventCount: 1,
    eventsTruncated: false,
    events: [
      {
        at: asIsoTimestamp(row.eventAt, "orphan event detail timestamp"),
        direction: row.eventDirection,
        outcome: row.eventOutcome,
        message: row.eventMessage,
        details: row.eventDetails,
      },
    ],
  };
}

async function readJournalPageFromTransaction(
  tx: JournalTransaction,
  tenantId: string,
  type: IntegrationChannelType,
  query: ResolvedJournalQuery,
): Promise<JournalPageDto> {
  const projection = journalRows(tenantId, type, query);
  const countResult = await tx.execute<{ total: number | string }>(sql`
    with journal_row as (${projection})
    select count(*)::int as "total"
    from journal_row
  `);
  const totalItems = Number(countResult.rows[0]?.total ?? 0);
  const offset = (query.page - 1) * query.pageSize;
  const pageResult = await tx.execute<JournalRow>(sql`
    with journal_row as (${projection})
    select *
    from journal_row
    order by "startedAt" desc, "id" desc
    limit ${query.pageSize}
    offset ${offset}
  `);

  const realSessionIds = pageResult.rows.filter((row) => !row.orphan).map((row) => row.id);
  const eventCounts = new Map<string, number>();
  const eventsBySessionId = new Map<string, JournalEventDto[]>();

  if (realSessionIds.length > 0) {
    const counts = await tx
      .select({
        sessionId: schema.integrationEvents.sessionId,
        eventCount: sql<number>`count(*)::int`,
      })
      .from(schema.integrationEvents)
      .where(
        and(
          eq(schema.integrationEvents.tenantId, tenantId),
          eq(schema.integrationEvents.channelType, type),
          inArray(schema.integrationEvents.sessionId, realSessionIds),
        ),
      )
      .groupBy(schema.integrationEvents.sessionId);
    for (const row of counts) {
      if (row.sessionId !== null) eventCounts.set(row.sessionId, Number(row.eventCount));
    }

    const sessionIdList = sql.join(
      realSessionIds.map((sessionId) => sql`${sessionId}::uuid`),
      sql`, `,
    );
    const eventResult = await tx.execute<EventRow>(sql`
      with ranked_item as (
        select
          event.id,
          event.session_id as "sessionId",
          event.at,
          event.direction,
          event.outcome,
          event.message,
          event.details,
          row_number() over (
            partition by event.session_id
            order by event.at desc, event.id desc
          ) as item_rank
        from integration_events event
        where event.tenant_id = ${tenantId}
          and event.channel_type = ${type}
          and event.session_id in (${sessionIdList})
          and event.grain = 'item'
      ), bounded_event as (
        select
          event.id,
          event.session_id as "sessionId",
          event.at,
          event.direction,
          event.outcome,
          event.message,
          event.details
        from integration_events event
        where event.tenant_id = ${tenantId}
          and event.channel_type = ${type}
          and event.session_id in (${sessionIdList})
          and event.grain = 'session'

        union all

        select
          ranked_item.id,
          ranked_item."sessionId",
          ranked_item.at,
          ranked_item.direction,
          ranked_item.outcome,
          ranked_item.message,
          ranked_item.details
        from ranked_item
        where ranked_item.item_rank <= ${JOURNAL_ITEM_EVENTS_PER_SESSION_LIMIT}
      )
      select *
      from bounded_event
      order by at asc, id asc
    `);
    for (const event of eventResult.rows) {
      const bucket = eventsBySessionId.get(event.sessionId);
      if (bucket) bucket.push(toEventDto(event));
      else eventsBySessionId.set(event.sessionId, [toEventDto(event)]);
    }
  }

  const [profile] = await tx
    .select({ timeZone: schema.orgProfiles.timeZone })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId))
    .limit(1);

  return {
    timeZone: profile?.timeZone ?? "Europe/Moscow",
    sessions: pageResult.rows.map((row) => {
      if (row.orphan) return orphanSession(row);
      const events = eventsBySessionId.get(row.id) ?? [];
      const eventCount = eventCounts.get(row.id) ?? 0;
      return {
        id: row.id,
        startedAt: asIsoTimestamp(row.startedAt, "session start timestamp"),
        finishedAt:
          row.finishedAt === null
            ? null
            : asIsoTimestamp(row.finishedAt, "session finish timestamp"),
        outcome: row.outcome,
        summary: row.summary,
        eventCount,
        eventsTruncated: eventCount > events.length,
        events,
      };
    }),
    pageInfo: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize),
    },
  };
}

function asIsoTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid journal ${field}`);
  return parsed.toISOString();
}

export function readJournalPage(
  db: Db,
  tenantId: string,
  type: IntegrationChannelType,
  query: ResolvedJournalQuery,
): Promise<JournalPageDto> {
  return db.transaction((tx) => readJournalPageFromTransaction(tx, tenantId, type, query), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
