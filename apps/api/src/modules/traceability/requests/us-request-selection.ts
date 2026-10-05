import { schema } from "@markiro/db";
import type { UsTraceRequestScopeV1 } from "@markiro/platform-contracts";
import { ConflictException, HttpException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { assertReceivingRootsReadable } from "../receiving/us-receiving-chain";
import { readReceivingLiveRecord } from "../receiving/us-receiving-history";
import { unavailable } from "../receiving/us-receiving-persistence";
import { readShippingRecord, readShippingRevisions } from "../shipping/us-shipping-history";
import { assertTraceRelations } from "../trace/us-trace-query";
import { readTransformationRecord } from "../transformation/us-transformation-persistence";
import { readTransformationRevisions } from "../transformation/us-transformation-revisions";
import {
  frozenRequestLines,
  requestRelations,
  requestSeedQueries,
} from "./us-request-selector-query";

type Role = "receiving" | "input" | "output" | "shipping";
type Relation = { eventId: string; lotId: string; lineNo: number; role: Role };
type RecordPin = {
  eventId: string;
  revision: number;
  reason: "match" | "dependency";
  rootEventId: string;
};
export type UsRequestSelection = {
  scope: UsTraceRequestScopeV1;
  seeds: readonly { kind: "lot" | "event"; id: string }[];
  records: readonly RecordPin[];
  lotIds: readonly string[];
  relations: readonly Relation[];
};
type Event = typeof schema.traceabilityEvents.$inferSelect;
const limit = 500;
const overflow = () => new ConflictException({ code: "us_request_selection_limit" });
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function requiresTransactionRetry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error.code === "40001" || error.code === "40P01")) return true;
  return "cause" in error && requiresTransactionRetry(error.cause);
}

/** Internal US seam. Caller owns authorization and one repeatable-read transaction. */
export async function selectUsRequestScope(
  tx: UsMasterDataTransaction,
  tenantId: string,
  scope: UsTraceRequestScopeV1,
): Promise<UsRequestSelection> {
  const queries = requestSeedQueries(tenantId, scope);
  const deadline = performance.now() + 30_000;
  const checkDeadline = () => {
    if (performance.now() > deadline) throw unavailable();
  };
  try {
    await tx.execute(sql`SET LOCAL statement_timeout='30s'`);
    const seeds: { kind: "lot" | "event"; id: string }[] = [];
    const lots = new Set<string>();
    // The contract bounds event revisions, not standalone lots. Keyset pagination
    // exhausts lot matches instead of silently discarding the 501st lot.
    if (queries.hasLotSelectors) {
      let after: string | undefined;
      for (;;) {
        checkDeadline();
        const page = await tx.execute<{ id: string }>(queries.lots(after));
        for (const row of page.rows.slice(0, 500)) {
          lots.add(row.id);
          seeds.push({ kind: "lot", id: row.id });
        }
        if (page.rows.length <= 500) break;
        after = page.rows[499]?.id;
        if (!after) throw unavailable();
      }
    }
    const matches = await tx.execute<{ id: string }>(queries.events);
    if (matches.rows.length > limit) throw overflow();
    const direct = new Set(matches.rows.map((row) => row.id));
    for (const id of direct) seeds.push({ kind: "event", id });
    const events = new Map<string, Event>();
    const relations: Relation[] = [];
    const visitedLots = new Set<string>();
    const visitedRoots = new Set<string>();
    let pendingIds = [...direct];
    for (;;) {
      checkDeadline();
      const frontier = [...lots].filter((id) => !visitedLots.has(id));
      if (frontier.length) {
        const existing = await tx
          .select({ id: schema.traceabilityLots.id })
          .from(schema.traceabilityLots)
          .where(
            and(
              eq(schema.traceabilityLots.tenantId, tenantId),
              inArray(schema.traceabilityLots.id, frontier),
            ),
          );
        if (existing.length !== frontier.length) throw unavailable();
        const integrity = await tx.execute<{
          invalid: boolean;
        }>(sql`${requestRelations(tenantId)} SELECT EXISTS (
          SELECT 1 FROM traceability_events e CROSS JOIN LATERAL (${frozenRequestLines()}) frozen
          WHERE e.tenant_id=${tenantId} AND frozen.value->>'lotId'=ANY(${sql.param(frontier)}::text[])
          AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.event_id=e.id AND r.type=e.type
            AND r.role=frozen.role AND r.line_no::text=frozen.value->>'lineNo' AND r.lot_id::text=frozen.value->>'lotId')
        ) AS invalid`);
        if (integrity.rows[0]?.invalid !== false) throw unavailable();
        const page = await tx.execute<{ id: string }>(sql`${requestRelations(tenantId)}
          SELECT DISTINCT r.event_id AS id FROM relations r WHERE r.lot_id=ANY(${sql.param(frontier)}::uuid[])
          AND NOT (r.event_id=ANY(${sql.param([...events.keys()])}::uuid[])) ORDER BY r.event_id LIMIT ${limit - events.size + 1}`);
        if (page.rows.length > limit - events.size) throw overflow();
        await assertTraceRelations(tx, tenantId, frontier);
        pendingIds.push(...page.rows.map((row) => row.id));
        for (const id of frontier) visitedLots.add(id);
      }
      pendingIds = [...new Set(pendingIds)].filter((id) => !events.has(id));
      if (!pendingIds.length) break;
      if (events.size + pendingIds.length > limit) throw overflow();
      const selected = await tx
        .select()
        .from(schema.traceabilityEvents)
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, tenantId),
            inArray(schema.traceabilityEvents.id, pendingIds),
          ),
        );
      if (selected.length !== pendingIds.length) throw unavailable();
      for (const row of selected) events.set(row.id, row);
      const roots = [...new Set(selected.map((row) => row.rootEventId))].filter(
        (id) => !visitedRoots.has(id),
      );
      if (roots.length) {
        const linked = await tx
          .select()
          .from(schema.traceabilityEvents)
          .where(
            and(
              eq(schema.traceabilityEvents.tenantId, tenantId),
              inArray(schema.traceabilityEvents.rootEventId, roots),
              sql`NOT (${schema.traceabilityEvents.id}=ANY(${sql.param([...events.keys()])}::uuid[]))`,
            ),
          )
          .limit(limit - events.size + 1);
        if (events.size + linked.length > limit) throw overflow();
        for (const row of linked) {
          events.set(row.id, row);
          selected.push(row);
        }
        for (const id of roots) visitedRoots.add(id);
      }
      const ids = selected.map((row) => row.id);
      const children = await tx.execute<
        Omit<Relation, "lotId"> & { lotId: string | null; type: string }
      >(sql`${requestRelations(tenantId)}
        SELECT event_id AS "eventId",lot_id AS "lotId",line_no AS "lineNo",role,type FROM relations
        WHERE event_id=ANY(${sql.param(ids)}::uuid[]) ORDER BY event_id,role,line_no LIMIT ${ids.length * 200 + 1}`);
      if (children.rows.length > ids.length * 200) throw unavailable();
      for (const child of children.rows) {
        if (events.get(child.eventId)?.type !== child.type) throw unavailable();
        if (child.lotId !== null) {
          relations.push({
            eventId: child.eventId,
            lotId: child.lotId,
            role: child.role,
            lineNo: child.lineNo,
          });
          lots.add(child.lotId);
        }
      }
      pendingIds = [];
    }
    // Root readers inspect complete chains. The entire bounded universe has been
    // counted first, so their history reads cannot evade the 500-revision ceiling.
    const checkedRoots = new Set<string>();
    for (const event of events.values()) {
      checkDeadline();
      if (!checkedRoots.has(event.rootEventId)) {
        if (event.type === "receiving")
          await assertReceivingRootsReadable(tx, tenantId, sql`r.id=${event.rootEventId}`);
        else if (event.type === "transformation")
          await readTransformationRevisions(tx, tenantId, event.id, { limit: 1, offset: 0 });
        else if (event.type === "shipping")
          await readShippingRevisions(tx, tenantId, event.id, { limit: 1, offset: 0 });
        else throw unavailable();
        checkedRoots.add(event.rootEventId);
      }
      await verifyRecordRelations(
        tx,
        tenantId,
        event,
        relations.filter((r) => r.eventId === event.id),
      );
    }
    checkDeadline();
    return {
      scope: queries.scope,
      seeds: seeds.sort((a, b) => order(a.kind, b.kind) || order(a.id, b.id)),
      records: [...events.values()]
        .map((row): RecordPin => ({
          eventId: row.id,
          revision: row.revision,
          rootEventId: row.rootEventId,
          reason: direct.has(row.id) ? "match" : "dependency",
        }))
        .sort((a, b) => order(a.eventId, b.eventId) || a.revision - b.revision),
      lotIds: [...lots].sort(order),
      relations: relations.sort(
        (a, b) => order(a.eventId, b.eventId) || order(a.role, b.role) || a.lineNo - b.lineNo,
      ),
    };
  } catch (error) {
    // Only the transaction owner can restart authorization and every source read
    // in a fresh snapshot. Preserve driver wrappers and their SQLSTATE causes.
    if (requiresTransactionRetry(error)) throw error;
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (
        error.getStatus() === 503 ||
        (typeof response === "object" &&
          "code" in response &&
          response.code === "us_request_selection_limit")
      )
        throw error;
    }
    // A pinned record disappearing, PostgreSQL cancellation or a broken edge is
    // a technical failure, never an empty or partially successful selection.
    throw unavailable();
  }
}

async function verifyRecordRelations(
  tx: UsMasterDataTransaction,
  tenantId: string,
  event: Event,
  relations: readonly Relation[],
) {
  const record = await (event.type === "receiving"
    ? readReceivingLiveRecord(tx, tenantId, event.id)
    : event.type === "transformation"
      ? readTransformationRecord(tx, tenantId, event.id)
      : event.type === "shipping"
        ? readShippingRecord(tx, tenantId, event.id)
        : Promise.reject(unavailable()));
  const expected: { lotId: string; lineNo: number; role: Role }[] = [];
  const lines = (items: readonly { lotId?: string | null; lineNo?: number }[], role: Role) => {
    items.forEach((line, index) => {
      if (line.lotId) expected.push({ lotId: line.lotId, lineNo: line.lineNo ?? index + 1, role });
    });
  };
  if ("content" in record) {
    if (
      record.content.kind === "finalized" &&
      (record.content.snapshot.dateReceived !== event.dateReceived ||
        record.content.snapshot.locationId !== event.locationId ||
        record.content.snapshot.previousSourceLocationId !== event.previousSourceLocationId)
    )
      throw unavailable();
    lines(
      record.content.kind === "finalized"
        ? record.content.snapshot.items
        : record.content.draft.items,
      "receiving",
    );
  } else if ("snapshot" in record) {
    if (
      record.snapshot.eventDate !== event.dateReceived ||
      record.snapshot.timeZone !== event.timeZone ||
      (record.snapshot.previousRevisionId ?? null) !== event.previousRevisionId
    )
      throw unavailable();
    if ("inputs" in record.snapshot) {
      if (record.snapshot.processor.id !== event.locationId) throw unavailable();
      lines(record.snapshot.inputs, "input");
      lines(record.snapshot.outputs, "output");
    } else {
      if (record.snapshot.shipFrom.locationId !== event.locationId) throw unavailable();
      lines(record.snapshot.items, "shipping");
    }
  } else if ("inputs" in record.draft) {
    lines(
      record.draft.inputs.filter((line) => line.kind === "ftl_lot"),
      "input",
    );
    // Saved amendment outputs retain their lot binding in the authoritative rows;
    // the editable draft transport intentionally omits that server-owned field.
    expected.push(...relations.filter((r) => r.role === "output"));
  } else lines(record.draft.items, "shipping");
  if (
    expected.length !== relations.length ||
    expected.some(
      (line) =>
        !relations.some(
          (r) => r.role === line.role && r.lineNo === line.lineNo && r.lotId === line.lotId,
        ),
    )
  )
    throw unavailable();
}
