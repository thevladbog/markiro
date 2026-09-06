import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { assertLotAssignmentBasis, assertLotTransition, US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  createTraceabilityLotSchema,
  listTraceabilityLotsQuerySchema,
  platformUuidSchema,
  postLotStatusSchema,
  patchLotSourceSchema,
  type TraceabilityLot,
  type TraceabilityLotList,
} from "@markiro/platform-contracts";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import {
  authorizeUsMasterData,
  escapeLikePattern,
  parseMasterDataInput,
  isUniqueConstraintViolation,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import {
  applyLotRule,
  assertLotReferences,
  lotResponse,
  lotSourceColumns,
  sourceIdentityPredicate,
} from "./us-lot-support";

const lots = schema.traceabilityLots;

/** Imported-record storage only; not an event origin, balance or export-ready service. */
export class UsLotStore {
  constructor(private readonly db: Db) {}

  async listLots(
    tenantId: string,
    actorUserId: string,
    query: unknown,
  ): Promise<TraceabilityLotList> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const value = parseMasterDataInput(listTraceabilityLotsQuerySchema, query);
      const search = value.search ? `%${escapeLikePattern(value.search)}%` : undefined;
      const rows = await tx
        .select()
        .from(lots)
        .where(
          and(
            eq(lots.tenantId, tenantId),
            value.productId ? eq(lots.productId, value.productId) : undefined,
            value.tlc ? eq(lots.tlc, value.tlc) : undefined,
            value.sourceLocationId
              ? or(
                  eq(lots.sourceLocationId, value.sourceLocationId),
                  eq(lots.sourceReferenceLocationId, value.sourceLocationId),
                )
              : undefined,
            value.assignmentBasis ? eq(lots.assignmentBasis, value.assignmentBasis) : undefined,
            value.status ? eq(lots.status, value.status) : undefined,
            search
              ? or(ilike(lots.tlc, search), ilike(lots.sourceReferenceValue, search))
              : undefined,
          ),
        )
        .orderBy(asc(lots.createdAt), asc(lots.id))
        .limit(value.limit)
        .offset(value.offset);
      return { items: rows.map(lotResponse), limit: value.limit, offset: value.offset };
    });
  }

  async getLot(tenantId: string, actorUserId: string, id: unknown): Promise<TraceabilityLot> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const lotId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx
        .select()
        .from(lots)
        .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
        .limit(1);
      if (!row) throw new NotFoundException({ code: "lot_not_found" });
      return lotResponse(row);
    });
  }

  async createLot(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<TraceabilityLot> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.MASTER_DATA_WRITE);
      const value = parseMasterDataInput(createTraceabilityLotSchema, input);
      applyLotRule(() => assertLotAssignmentBasis(value.assignmentBasis, "manual"));
      await assertLotReferences(tx, tenantId, value.productId, value.source);
      const now = new Date();
      const [row] = await tx
        .insert(lots)
        .values({
          tenantId,
          productId: value.productId,
          tlc: value.tlc,
          assignmentBasis: value.assignmentBasis,
          ...lotSourceColumns(value.source),
          createdBy: actorUserId,
          updatedBy: actorUserId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        const [existing] = await tx
          .select({ id: lots.id })
          .from(lots)
          .where(
            and(
              eq(lots.tenantId, tenantId),
              eq(lots.tlc, value.tlc),
              sourceIdentityPredicate(value.source),
            ),
          )
          .limit(1);
        if (!existing) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
        throw new ConflictException({ code: "LOT_DUPLICATE", existingId: existing.id });
      }
      const response = lotResponse(row);
      await this.audit(tx, tenantId, actorUserId, requestId, null, response);
      return response;
    });
  }

  async changeSource(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<TraceabilityLot> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.MASTER_DATA_WRITE);
      const lotId = parseMasterDataInput(platformUuidSchema, id);
      const value = parseMasterDataInput(patchLotSourceSchema, input);
      const [row] = await tx
        .select()
        .from(lots)
        .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
        .limit(1)
        .for("update");
      if (!row) throw new NotFoundException({ code: "lot_not_found" });
      const current = lotResponse(row);
      if (current.sourceLockedAt !== null)
        throw new ConflictException({ code: "lot_source_locked" });
      const source = lotSourceColumns(value.source);
      const sameSource =
        row.sourceLocationId === source.sourceLocationId &&
        row.sourceReferenceKind === source.sourceReferenceKind &&
        row.sourceReferenceValue === source.sourceReferenceValue &&
        row.sourceReferenceLocationId === source.sourceReferenceLocationId;
      if (value.expectedRevision !== current.revision) {
        if (
          value.expectedRevision === current.revision - 1 &&
          sameSource &&
          row.lastSourceReason === value.reason &&
          row.updatedBy === actorUserId
        )
          return current;
        throw new ConflictException({ code: "lot_revision_conflict" });
      }
      if (sameSource) return current;
      await assertLotReferences(tx, tenantId, row.productId, value.source);
      let updated: typeof lots.$inferSelect | undefined;
      try {
        // Recover a uniqueness conflict inside a savepoint before looking up its tenant-scoped ID.
        [updated] = await tx.transaction((savepoint) =>
          savepoint
            .update(lots)
            .set({
              ...source,
              revision: current.revision + 1,
              lastSourceReason: value.reason,
              lastStatusReason: null,
              updatedBy: actorUserId,
              updatedAt: new Date(),
            })
            .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
            .returning(),
        );
      } catch (error) {
        if (
          ![
            "traceability_lots_location_tlc_uq",
            "traceability_lots_reference_tlc_uq",
            "traceability_lots_missing_source_tlc_uq",
          ].some((constraint) => isUniqueConstraintViolation(error, constraint))
        )
          throw error;
        const [existing] = await tx
          .select({ id: lots.id })
          .from(lots)
          .where(
            and(
              eq(lots.tenantId, tenantId),
              eq(lots.tlc, row.tlc),
              sourceIdentityPredicate(value.source),
            ),
          )
          .limit(1);
        if (!existing) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
        throw new ConflictException({ code: "LOT_DUPLICATE", existingId: existing.id });
      }
      if (!updated) throw new NotFoundException({ code: "lot_not_found" });
      const response = lotResponse(updated);
      await this.audit(
        tx,
        tenantId,
        actorUserId,
        requestId,
        current,
        response,
        value.reason,
        "traceability.lot.source_changed",
      );
      return response;
    });
  }

  async changeStatus(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<TraceabilityLot> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
      const lotId = parseMasterDataInput(platformUuidSchema, id);
      const value = parseMasterDataInput(postLotStatusSchema, input);
      const [row] = await tx
        .select()
        .from(lots)
        .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
        .limit(1)
        .for("update");
      if (!row) throw new NotFoundException({ code: "lot_not_found" });
      const current = lotResponse(row);
      const sameAction =
        current.status === value.status &&
        row.lastStatusReason === value.reason &&
        row.updatedBy === actorUserId;
      if (value.expectedRevision !== current.revision) {
        if (value.expectedRevision === current.revision - 1 && sameAction) return current;
        throw new ConflictException({ code: "lot_revision_conflict" });
      }
      applyLotRule(() => assertLotTransition(current.status, value.status));
      const [updated] = await tx
        .update(lots)
        .set({
          status: value.status,
          revision: current.revision + 1,
          lastStatusReason: value.reason,
          lastSourceReason: null,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
        .returning();
      if (!updated) throw new NotFoundException({ code: "lot_not_found" });
      const response = lotResponse(updated);
      await this.audit(tx, tenantId, actorUserId, requestId, current, response, value.reason);
      return response;
    });
  }

  private async audit(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    requestId: string,
    before: TraceabilityLot | null,
    after: TraceabilityLot,
    reason?: string,
    action:
      | "traceability.lot.created"
      | "traceability.lot.status_changed"
      | "traceability.lot.source_changed" = before
      ? "traceability.lot.status_changed"
      : "traceability.lot.created",
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action,
      outcome: "success",
      targetType: "traceability_lot",
      targetId: after.id,
      before,
      after: reason === undefined ? after : { ...after, reason },
      requestId,
    });
  }
}
