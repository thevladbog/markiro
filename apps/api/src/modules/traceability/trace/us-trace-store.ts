import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usCurrentTraceQuerySchema,
  usCurrentTraceResultSchema,
  type UsCurrentTraceResult,
  type UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import { transformationTransaction } from "../transformation/us-transformation-operations";
import { assertCurrentTraceOrigin, readCurrentTraceFrontier } from "./us-trace-evidence";
import { walkCurrentTrace } from "./us-trace-project";
import {
  countExcludedTraceRevisions,
  parseTraceHistoryQuery,
  readTraceHistory,
} from "./us-trace-history";

export class UsTraceStore {
  constructor(private readonly db: Db) {}
  async history(
    tenantId: string,
    actorUserId: string,
    lotId: string,
    query: unknown,
  ): Promise<UsTraceHistoryPage> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        const id = parseMasterDataInput(platformUuidSchema, lotId);
        const request = parseTraceHistoryQuery(query);
        const lots = schema.traceabilityLots;
        const [lot] = await tx
          .select({ id: lots.id })
          .from(lots)
          .where(and(eq(lots.tenantId, tenantId), eq(lots.id, id)));
        if (!lot) throw new NotFoundException({ code: "trace_lot_not_found" });
        return readTraceHistory(tx, tenantId, id, request);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        throw error;
      throw unavailable();
    }
  }
  async read(
    tenantId: string,
    actorUserId: string,
    lotId: string,
    query: unknown,
  ): Promise<UsCurrentTraceResult> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        const id = parseMasterDataInput(platformUuidSchema, lotId);
        const request = parseMasterDataInput(usCurrentTraceQuerySchema, query);
        const lots = schema.traceabilityLots;
        const [root] = await tx
          .select({ lotId: lots.id, tlc: lots.tlc })
          .from(lots)
          .where(and(eq(lots.tenantId, tenantId), eq(lots.id, id)));
        if (!root) throw new NotFoundException({ code: "trace_lot_not_found" });
        const { graph, limit } = await walkCurrentTrace(
          { ...root, id: `lot:${id}`, kind: "lot" },
          request,
          (ids, direction) => readCurrentTraceFrontier(tx, tenantId, ids, direction, 2000),
        );
        const visible = graph.nodes.filter((node) => node.kind === "lot");
        const ids = visible.map((node) => node.lotId).sort();
        const identities = await tx
          .select({ id: lots.id, tlc: lots.tlc })
          .from(lots)
          .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, ids)));
        if (
          identities.length !== ids.length ||
          visible.some(
            (node) => !identities.some((lot) => lot.id === node.lotId && lot.tlc === node.tlc),
          )
        )
          throw unavailable();
        const origins = await assertCurrentTraceOrigin(tx, tenantId, ids);
        const count = await countExcludedTraceRevisions(tx, tenantId, ids);
        const result = usCurrentTraceResultSchema.safeParse({
          rootLotId: id,
          direction: request.direction,
          ...graph,
          findings: ids
            .filter((lot) => !origins.has(lot))
            .map((lotId) => ({ code: "origin_gap", lotId })),
          excludedSummary: { count },
          completion: {
            state: limit ? "limited" : "complete",
            ...(limit ? { limit } : {}),
            returnedNodes: graph.nodes.length,
            returnedEdges: graph.edges.length,
          },
        });
        if (!result.success) throw unavailable();
        return result.data;
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        throw error;
      throw unavailable();
    }
  }
}
