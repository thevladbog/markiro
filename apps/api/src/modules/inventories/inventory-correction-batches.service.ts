import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type { CreateInventoryCorrectionBatchDto, InventoryCorrectionBatchDto } from "./dto";
import {
  codeResultProjection,
  inventoryCorrectionUuid,
  inventoryProgressChangeRow,
  inventoryProjectionDigest,
  readCorrectionTimestamp,
  type CorrectionTransaction,
} from "./inventory-correction-common";
import {
  postgresUuidArray,
  resolveInventoryEvidenceEvents,
  type InventoryEvidenceFilter,
  type InventoryEvidenceSelectionEvent,
} from "./inventory-evidence-query";

type CodeResult = typeof schema.inventoryCodeResults.$inferSelect;
type StoredBatch = typeof schema.inventoryCorrectionBatches.$inferSelect;

interface TargetResult {
  eventId: string;
  before: CodeResult;
  after: CodeResult;
}

const WRITE_CHUNK_SIZE = 500;

@Injectable()
export class InventoryCorrectionBatchesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  correct(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: CreateInventoryCorrectionBatchDto,
  ): Promise<InventoryCorrectionBatchDto> {
    return this.db.transaction((tx) =>
      this.correctInTransaction(tx, tenantId, actorUserId, inventoryId, input),
    );
  }

  private async correctInTransaction(
    tx: CorrectionTransaction,
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: CreateInventoryCorrectionBatchDto,
  ): Promise<InventoryCorrectionBatchDto> {
    const [inventory] = await tx
      .select({
        status: schema.inventories.status,
        activeSnapshotId: schema.inventories.activeSnapshotId,
        resultRevision: schema.inventories.resultRevision,
      })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1)
      .for("update");
    if (!inventory) throw new NotFoundException({ code: "INVENTORY_NOT_FOUND" });

    const batchId = inventoryCorrectionUuid("batch", tenantId, inventoryId, input.idempotencyKey);
    const requestDigest = inventoryProjectionDigest(normalizedBatchRequest(input));
    const [existing] = await tx
      .select()
      .from(schema.inventoryCorrectionBatches)
      .where(
        and(
          eq(schema.inventoryCorrectionBatches.tenantId, tenantId),
          eq(schema.inventoryCorrectionBatches.inventoryId, inventoryId),
          eq(schema.inventoryCorrectionBatches.id, batchId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_IDEMPOTENCY_MISMATCH" });
      }
      return toBatchDto(existing);
    }

    if (inventory.status !== "running") {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_NOT_RUNNING" });
    }
    if (inventory.resultRevision !== input.expectedResultRevision) {
      throw new ConflictException({
        code: "INVENTORY_CORRECTION_STALE_REVISION",
        resultRevision: inventory.resultRevision,
      });
    }
    if (inventory.activeSnapshotId === null) {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_SNAPSHOT_MISSING" });
    }
    const snapshotId = inventory.activeSnapshotId;

    const events = await this.resolveSelection(tx, tenantId, inventoryId, input);
    if (events.length === 0) {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_BATCH_EMPTY" });
    }
    const results = await this.lockResults(tx, tenantId, inventoryId, events);
    const changedAt = await readCorrectionTimestamp(tx);
    const targets = await this.prepareTargets(
      tx,
      tenantId,
      inventoryId,
      input,
      events,
      results,
      changedAt,
    );
    if (targets.length === 0) {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_BATCH_EMPTY" });
    }

    const nextRevision = inventory.resultRevision + 1;
    const [batch] = await tx
      .insert(schema.inventoryCorrectionBatches)
      .values({
        id: batchId,
        tenantId,
        inventoryId,
        action: input.action,
        reason: input.reason,
        requestDigest,
        actorUserId,
        selectedEventCount: events.length,
        affectedCodeCount: targets.length,
        resultRevision: nextRevision,
        createdAt: changedAt,
      })
      .returning();
    if (!batch) throw new Error("Inventory correction batch insert returned no row");

    for (const chunk of chunks(targets, WRITE_CHUNK_SIZE)) {
      await tx.insert(schema.inventoryCorrections).values(
        chunk.map((target) => ({
          id: inventoryCorrectionUuid("batch-child", batchId, target.before.id),
          tenantId,
          inventoryId,
          batchId,
          action: input.action,
          reason: input.reason,
          requestDigest,
          actorUserId,
          targetEventId: target.eventId,
          targetCodeResultId: target.before.id,
          beforeProjectionDigest: inventoryProjectionDigest(codeResultProjection(target.before)),
          afterProjectionDigest: inventoryProjectionDigest(codeResultProjection(target.after)),
          resultRevision: nextRevision,
          effectAt: changedAt,
          createdAt: changedAt,
        })),
      );

      const ids = chunk.map((target) => target.before.id);
      await tx
        .update(schema.inventoryCodeResults)
        .set(
          input.action === "void_scan"
            ? { classification: "voided", updatedAt: changedAt }
            : { observedProductionDate: input.observedProductionDate, updatedAt: changedAt },
        )
        .where(
          and(
            eq(schema.inventoryCodeResults.tenantId, tenantId),
            eq(schema.inventoryCodeResults.inventoryId, inventoryId),
            sql`${schema.inventoryCodeResults.id} = any(${postgresUuidArray(ids)}::uuid[])`,
          ),
        );

      await tx.insert(schema.inventoryProgressChanges).values(
        chunk.map((target) =>
          inventoryProgressChangeRow({
            tenantId,
            inventoryId,
            snapshotId,
            resultRevision: nextRevision,
            result: target.after,
            changedAt,
          }),
        ),
      );
    }

    await tx
      .update(schema.inventories)
      .set({ resultRevision: nextRevision, updatedAt: changedAt })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );

    return toBatchDto(batch);
  }

  private async resolveSelection(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    input: CreateInventoryCorrectionBatchDto,
  ): Promise<InventoryEvidenceSelectionEvent[]> {
    if (input.selection.mode === "explicit") {
      const events = await resolveInventoryEvidenceEvents(tx, {
        tenantId,
        inventoryId,
        filter: { scope: "all" },
        eventIds: input.selection.eventIds,
        order: "stable_lock",
      });
      if (events.length !== input.selection.eventIds.length) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_BATCH_SELECTION_CHANGED" });
      }
      return events;
    }

    const filter: InventoryEvidenceFilter = {
      scope: input.selection.filter.scope,
      ...(input.selection.filter.search === undefined
        ? {}
        : { search: input.selection.filter.search }),
      ...(input.selection.filter.kind === undefined ? {} : { kind: input.selection.filter.kind }),
      ...(input.selection.filter.classification === undefined
        ? {}
        : { classification: input.selection.filter.classification }),
      ...(input.selection.filter.discrepancyCategory === undefined
        ? {}
        : { discrepancyCategory: input.selection.filter.discrepancyCategory }),
    };
    return resolveInventoryEvidenceEvents(tx, {
      tenantId,
      inventoryId,
      filter,
      excludedEventIds: input.selection.excludedEventIds,
      order: "stable_lock",
    });
  }

  private async lockResults(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    events: readonly InventoryEvidenceSelectionEvent[],
  ): Promise<CodeResult[]> {
    const eventIds = events.map((event) => event.eventId);
    return tx
      .select()
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          sql`${schema.inventoryCodeResults.firstAcceptedEventId} = any(${postgresUuidArray(eventIds)}::uuid[])`,
        ),
      )
      .orderBy(schema.inventoryCodeResults.id)
      .for("update");
  }

  private async prepareTargets(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    input: CreateInventoryCorrectionBatchDto,
    events: readonly InventoryEvidenceSelectionEvent[],
    results: readonly CodeResult[],
    changedAt: Date,
  ): Promise<TargetResult[]> {
    const resultsByEvent = new Map<string, CodeResult[]>();
    for (const result of results) {
      const current = resultsByEvent.get(result.firstAcceptedEventId) ?? [];
      current.push(result);
      resultsByEvent.set(result.firstAcceptedEventId, current);
    }

    if (input.action === "change_date") {
      if (results.some((result) => result.classification === "voided")) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_BATCH_SELECTION_CHANGED" });
      }
      const resultIds = results.map((result) => result.id);
      const [membership] =
        resultIds.length === 0
          ? []
          : await tx
              .select({ id: schema.inventoryRepackItems.id })
              .from(schema.inventoryRepackItems)
              .where(
                and(
                  eq(schema.inventoryRepackItems.tenantId, tenantId),
                  eq(schema.inventoryRepackItems.inventoryId, inventoryId),
                  isNull(schema.inventoryRepackItems.removedAt),
                  sql`${schema.inventoryRepackItems.resultId} = any(${postgresUuidArray(resultIds)}::uuid[])`,
                ),
              )
              .limit(1)
              .for("update");
      if (membership) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_ACTIVE_BOX_CONFLICT" });
      }
    }

    const targets: TargetResult[] = [];
    for (const event of events) {
      const eventResults = resultsByEvent.get(event.eventId) ?? [];
      const eligible =
        input.action === "void_scan"
          ? eventResults.filter((result) => result.classification !== "voided")
          : eventResults;
      if (eligible.length === 0) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_BATCH_SELECTION_CHANGED" });
      }
      for (const before of eligible) {
        const after: CodeResult = {
          ...before,
          ...(input.action === "void_scan"
            ? { classification: "voided" as const }
            : { observedProductionDate: input.observedProductionDate }),
          updatedAt: changedAt,
        };
        targets.push({ eventId: event.eventId, before, after });
      }
    }
    return targets;
  }
}

function normalizedBatchRequest(input: CreateInventoryCorrectionBatchDto): Record<string, unknown> {
  return {
    action: input.action,
    selection: input.selection,
    reason: input.reason,
    expectedResultRevision: input.expectedResultRevision,
    idempotencyKey: input.idempotencyKey,
    ...(input.action === "change_date"
      ? { observedProductionDate: input.observedProductionDate }
      : {}),
  };
}

function toBatchDto(batch: StoredBatch): InventoryCorrectionBatchDto {
  if (batch.action !== "void_scan" && batch.action !== "change_date") {
    throw new Error("Inventory correction batch action is invalid");
  }
  return {
    id: batch.id,
    action: batch.action,
    selectedEventCount: batch.selectedEventCount,
    affectedCodeCount: batch.affectedCodeCount,
    resultRevision: batch.resultRevision,
    createdAt: batch.createdAt.toISOString(),
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
