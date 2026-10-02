import { schema } from "@markiro/db";
import {
  receivingFinalizationSnapshotSchema,
  receivingFinalizationSnapshotV3Schema,
  shippingFinalizationSnapshotV1Schema,
  transformationFinalizationSnapshotV1Schema,
  usLotCardSchema,
  usLotCardEvidencePageSchema,
  type UsLotCard,
  type UsLotCardEvidenceQuery,
} from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { lotResponse } from "../lots/us-lot-support";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import { readCurrentShippingBalanceProjection } from "../shipping/us-shipping-balance";
import { loadAndValidateFrozenEvents, type TraceEventEvidence } from "./us-trace-evidence";
import { assertTraceRelations, traceRelations } from "./us-trace-query";
import { currentSummaries } from "./us-trace-search";

type Event = typeof schema.traceabilityEvents.$inferSelect;
type FrozenEvent = { row: Event; evidence: TraceEventEvidence };
type Origin = UsLotCard["currentOriginProducts"][number];

async function requireLot(tx: UsMasterDataTransaction, tenantId: string, lotId: string) {
  const lots = schema.traceabilityLots;
  const [row] = await tx
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)));
  if (!row) throw new NotFoundException({ code: "trace_lot_not_found" });
  return lotResponse(row);
}

function receivingSnapshot(row: Event) {
  const legacy = receivingFinalizationSnapshotSchema.safeParse(row.finalizationSnapshot);
  if (legacy.success) return legacy.data;
  const current = receivingFinalizationSnapshotV3Schema.safeParse(row.finalizationSnapshot);
  if (!current.success) throw unavailable();
  return current.data;
}

/** Preserve every direct origin line; a lot can have several current Receiving contributions. */
function originProducts(row: Event, lotId: string): Origin[] {
  const eventDate = row.dateReceived;
  if (!eventDate) throw unavailable();
  const provenance = {
    eventId: row.id,
    rootId: row.rootEventId,
    revision: row.revision,
    eventDate,
  };
  if (row.type === "receiving") {
    return receivingSnapshot(row)
      .items.filter((line) => line.lotId === lotId)
      .map((line) => ({
        ...provenance,
        eventDate: provenance.eventDate,
        lineNo: line.lineNo,
        kind: "receiving" as const,
        productId: line.productId,
        description: line.productDescription,
      }));
  }
  if (row.type === "transformation") {
    const snapshot = transformationFinalizationSnapshotV1Schema.parse(row.finalizationSnapshot);
    return snapshot.outputs
      .filter((line) => line.lotId === lotId)
      .map((line) => ({
        ...provenance,
        eventDate: provenance.eventDate,
        lineNo: line.lineNo,
        kind: "transformation" as const,
        productId: line.product.id,
        description: line.product.description,
      }));
  }
  return [];
}

/** Page direct current IDs before hydrating bounded snapshots; never walk genealogy here. */
export async function selectDirectCurrentEvents(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  after: UsLotCardEvidenceQuery["cursor"],
  limitPlusOne: number,
): Promise<FrozenEvent[]> {
  if (!Number.isInteger(limitPlusOne) || limitPlusOne < 2 || limitPlusOne > 51) throw unavailable();
  const selected = await tx.execute<{ id: string }>(sql`${traceRelations(tenantId, [lotId])}
    SELECT e.id FROM traceability_events e
    JOIN roots r ON r.id=e.root_event_id AND r.type=e.type AND r.current_event_id=e.id
    WHERE e.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
      AND EXISTS (SELECT 1 FROM children c WHERE c.event_id=e.id AND c.type=e.type)
      ${after ? sql`AND (e.event_date,e.id)>(${after.eventDate}::date,${after.eventId}::uuid)` : sql``}
    ORDER BY e.event_date,e.id LIMIT ${limitPlusOne}`);
  const ids = selected.rows.map((row) => row.id);
  if (!ids.length) return [];
  const evidence = await loadAndValidateFrozenEvents(tx, tenantId, ids);
  const rows = await tx
    .select()
    .from(schema.traceabilityEvents)
    .where(
      and(
        eq(schema.traceabilityEvents.tenantId, tenantId),
        inArray(schema.traceabilityEvents.id, ids),
      ),
    );
  return evidence.map((event) => {
    const row = rows.find((candidate) => candidate.id === event.id);
    if (!row) throw unavailable();
    return { row, evidence: event };
  });
}

/** Child identities are the persisted composite (event ID, line kind/table, lineNo), not UUIDs. */
export function frozenCardEvidence({ row, evidence }: FrozenEvent, lotId: string) {
  const origins = originProducts(row, lotId);
  const documents =
    row.type === "receiving"
      ? receivingSnapshot(row).documents.map(({ document }) => ({
          documentId: document.documentId,
          type: document.type === "other" ? document.typeOtherLabel : document.type,
          number: document.number,
        }))
      : (row.type === "transformation"
          ? transformationFinalizationSnapshotV1Schema.parse(row.finalizationSnapshot)
          : shippingFinalizationSnapshotV1Schema.parse(row.finalizationSnapshot)
        ).documents.map((document) => ({
          documentId: document.id,
          type: document.type,
          number: document.number,
        }));
  return {
    eventId: evidence.id,
    rootId: evidence.rootId,
    type: evidence.type,
    eventNumber: evidence.eventNumber,
    revision: evidence.revision,
    eventDate: evidence.eventDate,
    timeZone: evidence.timeZone,
    lines: evidence.lines
      .filter((line) => line.lotId === lotId)
      .map((line) => {
        const origin = origins.find(
          (candidate) =>
            candidate.lineNo === line.lineNo &&
            (candidate.kind === "receiving" ? line.side === "receiving" : line.side === "output"),
        );
        return {
          kind:
            line.side === "input"
              ? "transformation_input"
              : line.side === "output"
                ? "transformation_output"
                : line.side,
          lineNo: line.lineNo,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
          originProduct: origin
            ? { kind: origin.kind, productId: origin.productId, description: origin.description }
            : null,
        };
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.lineNo - b.lineNo),
    documents,
  };
}

export function encodeEvidenceCursor(event: FrozenEvent) {
  return Buffer.from(
    JSON.stringify({ eventDate: event.evidence.eventDate, eventId: event.evidence.id }),
  ).toString("base64url");
}

export async function readUsLotCardEvidence(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  query: UsLotCardEvidenceQuery,
) {
  await requireLot(tx, tenantId, lotId);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await assertTraceRelations(tx, tenantId, [lotId]);
  const events = await selectDirectCurrentEvents(
    tx,
    tenantId,
    lotId,
    query.cursor,
    query.limit + 1,
  );
  const visible = events.slice(0, query.limit);
  const last = visible.at(-1);
  return usLotCardEvidencePageSchema.parse({
    items: visible.map((event) => frozenCardEvidence(event, lotId)),
    nextCursor: events.length > query.limit && last ? encodeEvidenceCursor(last) : null,
  });
}

export async function readUsLotCard(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
): Promise<UsLotCard> {
  const lot = await requireLot(tx, tenantId, lotId);
  const deadline = performance.now() + 5000;
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  const currentOriginProducts: Origin[] = [];
  let currentOriginProductCount = 0;
  const summaries = await currentSummaries(tx, tenantId, [lotId], deadline, (row) => {
    const origins = originProducts(row, lotId);
    currentOriginProductCount += origins.length;
    // Bounded preview independent of event hydration order; full values remain in evidence pages.
    currentOriginProducts.push(...origins);
    currentOriginProducts.sort(
      (a, b) =>
        a.eventDate.localeCompare(b.eventDate) ||
        a.eventId.localeCompare(b.eventId) ||
        a.lineNo - b.lineNo,
    );
    currentOriginProducts.splice(50);
  });
  const products = schema.products;
  const [product] = await tx
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.id, lot.productId)));
  const counts = await tx.execute<{ activeCount: number; historicalCount: number }>(sql`SELECT
    count(*) FILTER (WHERE unlinked_at IS NULL)::int AS "activeCount",
    count(*) FILTER (WHERE unlinked_at IS NOT NULL)::int AS "historicalCount"
    FROM trace_lot_boxes WHERE tenant_id=${tenantId} AND lot_id=${lotId}::uuid`);
  const { balance } = await readCurrentShippingBalanceProjection(tx, tenantId, lotId);
  if (performance.now() > deadline) throw unavailable();
  return usLotCardSchema.parse({
    lot: {
      id: lot.id,
      tlc: lot.tlc,
      productId: lot.productId,
      source: lot.source,
      status: lot.status,
    },
    currentMasterProduct: product ?? null,
    currentOriginProducts,
    currentOriginProductCount,
    moreCurrentOriginProducts: currentOriginProductCount > 50,
    originState: currentOriginProductCount ? "current" : "gap",
    caseSummary: counts.rows[0],
    balance,
    ...summaries.get(lotId),
    links: { cases: "cases", trace: "trace", history: "trace/history" },
  });
}
