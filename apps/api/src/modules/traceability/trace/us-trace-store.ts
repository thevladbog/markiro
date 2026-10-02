import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usCurrentTraceQuerySchema,
  usCurrentTraceResultSchema,
  type UsCurrentTraceResult,
  type UsTraceHistoryPage,
  type UsTraceSearchPage,
  type UsLotCard,
  type UsLotCardEvidencePage,
  type UsReadinessResult,
} from "@markiro/platform-contracts";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { parseUsTraceSearchQuery, parseUsLotCardEvidenceQuery } from "./us-trace-search-query";
import { searchUsTraceability } from "./us-trace-search";
import { readUsLotCard, readUsLotCardEvidence } from "./us-lot-card";
import { parseUsReadinessQuery, resolveUsReadinessScope } from "./us-readiness-query";
import { assessUsReadiness } from "./us-readiness-assessment";
import { UsReadinessScopeTooLargeException } from "./us-readiness-errors";

export class UsTraceStore {
  constructor(private readonly db: Db) {}
  async readiness(
    tenantId: string,
    actorUserId: string,
    rawQuery: unknown,
  ): Promise<UsReadinessResult> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        const deadline = performance.now() + 5000;
        await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        const profileCode = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.READ,
        );
        const [profile] = await tx
          .select({ timeZone: schema.orgProfiles.timeZone })
          .from(schema.orgProfiles)
          .where(eq(schema.orgProfiles.tenantId, tenantId));
        if (!profile) throw unavailable();
        const instant = new Date();
        const tenantToday = new Intl.DateTimeFormat("en-CA", {
          timeZone: profile.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(instant);
        const scope = resolveUsReadinessScope(
          parseUsReadinessQuery(rawQuery),
          tenantToday,
          profileCode,
        );
        if (scope.productId !== null) {
          const [product] = await tx
            .select({ id: schema.products.id })
            .from(schema.products)
            .where(
              and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, scope.productId)),
            );
          if (!product) throw new NotFoundException({ code: "us_readiness_scope_not_found" });
        }
        if (scope.lotId !== null) {
          const [lot] = await tx
            .select({ id: schema.traceabilityLots.id })
            .from(schema.traceabilityLots)
            .where(
              and(
                eq(schema.traceabilityLots.tenantId, tenantId),
                eq(schema.traceabilityLots.id, scope.lotId),
              ),
            );
          if (!lot) throw new NotFoundException({ code: "us_readiness_scope_not_found" });
        }
        const result = await assessUsReadiness(
          tx,
          tenantId,
          scope,
          profileCode,
          instant.toISOString(),
        );
        if (performance.now() >= deadline) throw unavailable();
        return result;
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof UsReadinessScopeTooLargeException
      )
        throw error;
      throw unavailable();
    }
  }
  async card(tenantId: string, actorUserId: string, lotId: string): Promise<UsLotCard> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return readUsLotCard(tx, tenantId, parseMasterDataInput(platformUuidSchema, lotId));
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
  async cardEvidence(
    tenantId: string,
    actorUserId: string,
    lotId: string,
    rawQuery: unknown,
  ): Promise<UsLotCardEvidencePage> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return readUsLotCardEvidence(
          tx,
          tenantId,
          parseMasterDataInput(platformUuidSchema, lotId),
          parseUsLotCardEvidenceQuery(rawQuery),
        );
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
  async search(
    tenantId: string,
    actorUserId: string,
    rawQuery: unknown,
  ): Promise<UsTraceSearchPage> {
    try {
      return await transformationTransaction(this.db, async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return searchUsTraceability(tx, tenantId, parseUsTraceSearchQuery(rawQuery));
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ForbiddenException) throw error;
      throw unavailable();
    }
  }
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
