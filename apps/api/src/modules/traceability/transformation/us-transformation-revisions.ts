import { schema } from "@markiro/db";
import { NotFoundException } from "@nestjs/common";
import {
  transformationRevisionListSchema,
  type TransformationRevisionList,
  type TransformationRevisionListQuery,
} from "@markiro/platform-contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-transformation-persistence";

const events = schema.traceabilityEvents;
const roots = schema.transformationEventRoots;

/** Validate the complete chain before returning a page, including rows outside that page. */
export async function readTransformationRevisions(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  query: TransformationRevisionListQuery,
): Promise<TransformationRevisionList> {
  const [anchor] = await tx
    .select({ rootId: events.rootEventId })
    .from(events)
    .where(
      and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "transformation")),
    );
  if (!anchor) throw new NotFoundException({ code: "transformation_not_found" });
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
  let currentCount = 0;
  let pendingCount = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) throw unavailable();
    if (
      row.revision !== index + 1 ||
      row.rootId !== root.id ||
      row.type !== "transformation" ||
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
  const parsed = transformationRevisionListSchema.safeParse({
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
