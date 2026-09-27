import { schema, type Db } from "@markiro/db";
import { projectTransformationGenealogy, US_CAPABILITY } from "@markiro/domain";
import {
  transformationGenealogyRequestSchema,
  transformationGenealogyResultSchema,
  type TransformationGenealogyResult,
} from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { transformationTransaction } from "./us-transformation-operations";
import { unavailable } from "./us-transformation-persistence";
import {
  currentFrontierEvents,
  genealogyEdges,
  genealogyEvents,
  genealogyLotIds,
  genealogyLots,
  sortedIds,
  type GenealogyEvent,
} from "./us-transformation-genealogy-query";

/** Internal read boundary. Business rows are never locked or mutated. */
export function readTransformationGenealogy(
  db: Db,
  tenantId: string,
  actorUserId: string,
  input: unknown,
): Promise<TransformationGenealogyResult> {
  return transformationTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
    const request = parseMasterDataInput(transformationGenealogyRequestSchema, input);
    const [start] = await tx
      .select({ id: schema.traceabilityLots.id })
      .from(schema.traceabilityLots)
      .where(
        and(
          eq(schema.traceabilityLots.tenantId, tenantId),
          eq(schema.traceabilityLots.id, request.startLotId),
        ),
      );
    if (!start) throw new NotFoundException({ code: "transformation_reference_not_found" });
    const events = new Map<string, GenealogyEvent>();
    const lotIds = new Set([start.id]);
    let limited = false;
    if (request.mode === "pinned") {
      for (const event of await genealogyEvents(
        tx,
        tenantId,
        sortedIds(request.pinnedRevisionIds),
        false,
      ))
        events.set(event.id, event);
    } else {
      let frontier = [start.id];
      const visited = new Set<string>();
      // One extra frontier detects evidence beyond maxDepth without expanding it.
      for (let depth = 0; frontier.length && depth <= request.maxDepth; depth++) {
        const ids = await currentFrontierEvents(
          tx,
          tenantId,
          frontier,
          request.direction,
          request.maxNodes + 1,
        );
        const fresh = ids.filter((id) => !events.has(id));
        if (depth === request.maxDepth) {
          limited ||= fresh.length > 0;
          break;
        }
        if (fresh.length && events.size + lotIds.size >= request.maxNodes) {
          limited = true;
          break;
        }
        const capacity = Math.max(0, request.maxNodes - events.size);
        limited ||= fresh.length > capacity;
        const selected = await genealogyEvents(tx, tenantId, fresh.slice(0, capacity), true);
        const next = new Set<string>();
        for (const id of frontier) visited.add(id);
        for (const [index, event] of selected.entries()) {
          events.set(event.id, event);
          for (const line of event.snapshot?.inputs ?? [])
            if (line.kind === "ftl_lot") {
              lotIds.add(line.lotId);
              if (request.direction === "upstream" && !visited.has(line.lotId))
                next.add(line.lotId);
            }
          for (const line of event.snapshot?.outputs ?? []) {
            lotIds.add(line.lotId);
            if (request.direction === "downstream" && !visited.has(line.lotId))
              next.add(line.lotId);
          }
          if (events.size + lotIds.size >= request.maxNodes && index + 1 < selected.length) {
            limited = true;
            break;
          }
        }
        frontier = sortedIds(next);
      }
    }
    for (const event of events.values()) {
      for (const line of event.snapshot?.inputs ?? [])
        if (line.kind === "ftl_lot") lotIds.add(line.lotId);
      for (const line of event.snapshot?.outputs ?? []) lotIds.add(line.lotId);
    }
    const links = await genealogyEdges(
      tx,
      tenantId,
      sortedIds(events.keys()),
      request.mode === "current",
    );
    const identities = await genealogyLotIds(tx, tenantId, sortedIds(lotIds));
    if (identities.length !== lotIds.size) throw unavailable();
    // Topology/limits do not depend on origin availability. Validate all frozen
    // lot references, then query current origin only for the bounded visible lots.
    // The provisional projection is discarded and never returned as evidence.
    const projection = {
      ...request,
      lots: identities.map((lot) => ({ ...lot, currentOrigin: false })),
      events: [...events.values()],
      links,
      // The query returns an ordered 2,001-row prefix including the limit sentinel.
      linksTruncated: links.length > 2000,
    };
    const visible = projectTransformationGenealogy(projection).lots;
    const origins = new Map(
      (
        await genealogyLots(
          tx,
          tenantId,
          visible.map((lot) => lot.id),
        )
      ).map((lot) => [lot.id, lot.currentOrigin]),
    );
    const result = projectTransformationGenealogy({
      ...projection,
      lots: projection.lots.map((lot) => ({ ...lot, currentOrigin: origins.get(lot.id) ?? false })),
    });
    if (limited) {
      result.complete = false;
      result.diagnostics.push({ code: "limit" });
      result.diagnostics.sort((a, b) =>
        `${a.code}/${a.eventId ?? ""}/${a.lotId ?? ""}`.localeCompare(
          `${b.code}/${b.eventId ?? ""}/${b.lotId ?? ""}`,
          "en",
        ),
      );
    }
    const parsed = transformationGenealogyResultSchema.safeParse(result);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  });
}
