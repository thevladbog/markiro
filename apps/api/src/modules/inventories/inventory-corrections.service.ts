import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type {
  CreateInventoryCorrectionDto,
  InventoryCorrectionDto,
  InventoryCorrectionTargetDto,
} from "./dto";
import {
  codeResultProjection,
  inventoryCorrectionUuid,
  inventoryProgressChangeRow,
  inventoryProjectionDigest,
  readCorrectionTimestamp,
  type CorrectionTransaction,
} from "./inventory-correction-common";

type StoredCorrection = typeof schema.inventoryCorrections.$inferSelect;
type CodeResult = typeof schema.inventoryCodeResults.$inferSelect;
type RepackBox = typeof schema.inventoryRepackBoxes.$inferSelect;
type RepackItem = typeof schema.inventoryRepackItems.$inferSelect;

function repackBoxProjection(
  box: Pick<
    RepackBox,
    | "id"
    | "state"
    | "printState"
    | "printAttemptCount"
    | "printErrorCode"
    | "invalidatedAt"
    | "printedAt"
    | "updatedAt"
  >,
) {
  return {
    kind: "repack_box",
    id: box.id,
    state: box.state,
    printState: box.printState,
    printAttemptCount: box.printAttemptCount,
    printErrorCode: box.printErrorCode,
    invalidatedAt: box.invalidatedAt?.toISOString() ?? null,
    printedAt: box.printedAt?.toISOString() ?? null,
    updatedAt: box.updatedAt.toISOString(),
  };
}

function repackItemProjection(
  item: Pick<
    RepackItem,
    "id" | "boxId" | "resultId" | "removedAt" | "activeObservedProductionDate"
  >,
) {
  return {
    kind: "repack_item",
    id: item.id,
    boxId: item.boxId,
    resultId: item.resultId,
    removedAt: item.removedAt?.toISOString() ?? null,
    activeObservedProductionDate: item.activeObservedProductionDate,
  };
}

function normalizedRequestDigest(input: CreateInventoryCorrectionDto): string {
  return inventoryProjectionDigest({
    action: input.action,
    target: input.target,
    reason: input.reason,
    expectedResultRevision: input.expectedResultRevision,
    idempotencyKey: input.idempotencyKey,
    ...(input.action === "change_date"
      ? { observedProductionDate: input.observedProductionDate }
      : {}),
  });
}

function targetFromStored(correction: StoredCorrection): InventoryCorrectionTargetDto {
  return {
    eventId: correction.targetEventId,
    codeResultId: correction.targetCodeResultId,
    repackBoxId: correction.targetRepackBoxId,
  };
}

function toDto(correction: StoredCorrection): InventoryCorrectionDto {
  return {
    id: correction.id,
    action: correction.action,
    reason: correction.reason,
    target: targetFromStored(correction),
    beforeProjectionDigest: correction.beforeProjectionDigest,
    afterProjectionDigest: correction.afterProjectionDigest,
    resultRevision: correction.resultRevision,
    createdAt: correction.createdAt.toISOString(),
  };
}

@Injectable()
export class InventoryCorrectionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  correct(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: CreateInventoryCorrectionDto,
  ): Promise<InventoryCorrectionDto> {
    return this.db.transaction((tx) =>
      this.correctInTransaction(tx, tenantId, actorUserId, inventoryId, input),
    );
  }

  private async correctInTransaction(
    tx: CorrectionTransaction,
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: CreateInventoryCorrectionDto,
  ): Promise<InventoryCorrectionDto> {
    const [inventory] = await tx
      .select({
        id: schema.inventories.id,
        status: schema.inventories.status,
        activeSnapshotId: schema.inventories.activeSnapshotId,
        resultRevision: schema.inventories.resultRevision,
      })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1)
      .for("update");
    if (!inventory) throw new NotFoundException({ code: "INVENTORY_NOT_FOUND" });

    const id = inventoryCorrectionUuid("single", tenantId, inventoryId, input.idempotencyKey);
    const requestDigest = normalizedRequestDigest(input);
    const [existing] = await tx
      .select()
      .from(schema.inventoryCorrections)
      .where(
        and(
          eq(schema.inventoryCorrections.tenantId, tenantId),
          eq(schema.inventoryCorrections.inventoryId, inventoryId),
          eq(schema.inventoryCorrections.id, id),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_IDEMPOTENCY_MISMATCH" });
      }
      return toDto(existing);
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
    if (!inventory.activeSnapshotId) {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_SNAPSHOT_MISSING" });
    }

    const nextRevision = inventory.resultRevision + 1;
    const changedAt = await readCorrectionTimestamp(tx);
    const prepared = await this.prepareMutation(
      tx,
      tenantId,
      inventoryId,
      inventory.activeSnapshotId,
      nextRevision,
      input,
      changedAt,
    );
    const [correction] = await tx
      .insert(schema.inventoryCorrections)
      .values({
        id,
        tenantId,
        inventoryId,
        action: input.action,
        reason: input.reason,
        requestDigest,
        actorUserId,
        targetEventId: prepared.target.eventId,
        targetCodeResultId: prepared.target.codeResultId,
        targetRepackBoxId: prepared.target.repackBoxId,
        beforeProjectionDigest: prepared.beforeProjectionDigest,
        afterProjectionDigest: prepared.afterProjectionDigest,
        resultRevision: nextRevision,
        effectAt: prepared.effectAt,
        createdAt: changedAt,
      })
      .returning();
    if (!correction) throw new Error("Inventory correction insert returned no row");

    await prepared.apply();
    await tx
      .update(schema.inventories)
      .set({ resultRevision: nextRevision, updatedAt: changedAt })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    return toDto(correction);
  }

  private async prepareMutation(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    snapshotId: string,
    nextRevision: number,
    input: CreateInventoryCorrectionDto,
    changedAt: Date,
  ): Promise<{
    target: InventoryCorrectionTargetDto;
    beforeProjectionDigest: string;
    afterProjectionDigest: string;
    effectAt: Date;
    apply: () => Promise<void>;
  }> {
    if (input.action === "void_scan" || input.action === "restore_scan") {
      const eventId = input.target.eventId;
      if (!eventId) throw new Error("Validated scan correction has no event target");
      const [result] = await tx
        .select()
        .from(schema.inventoryCodeResults)
        .where(
          and(
            eq(schema.inventoryCodeResults.tenantId, tenantId),
            eq(schema.inventoryCodeResults.inventoryId, inventoryId),
            eq(schema.inventoryCodeResults.firstAcceptedEventId, eventId),
          ),
        )
        .limit(1)
        .for("update");
      if (!result) throw new NotFoundException({ code: "INVENTORY_CORRECTION_TARGET_NOT_FOUND" });
      const classification = input.action === "void_scan" ? "voided" : result.originClassification;
      if (
        (input.action === "void_scan" && result.classification === "voided") ||
        (input.action === "restore_scan" && result.classification !== "voided")
      ) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_STATE_CONFLICT" });
      }
      const after = { ...result, classification, updatedAt: changedAt };
      return {
        target: { eventId, codeResultId: result.id, repackBoxId: null },
        beforeProjectionDigest: inventoryProjectionDigest(codeResultProjection(result)),
        afterProjectionDigest: inventoryProjectionDigest(codeResultProjection(after)),
        effectAt: changedAt,
        apply: async () => {
          await tx
            .update(schema.inventoryCodeResults)
            .set({ classification, updatedAt: changedAt })
            .where(
              and(
                eq(schema.inventoryCodeResults.tenantId, tenantId),
                eq(schema.inventoryCodeResults.inventoryId, inventoryId),
                eq(schema.inventoryCodeResults.id, result.id),
              ),
            );
          await this.recordProgressChange(
            tx,
            tenantId,
            inventoryId,
            snapshotId,
            nextRevision,
            after,
            changedAt,
          );
        },
      };
    }

    if (input.action === "change_date") {
      const resultId = input.target.codeResultId;
      const observedProductionDate = input.observedProductionDate;
      if (!resultId || !observedProductionDate) {
        throw new Error("Validated date correction is incomplete");
      }
      const result = await this.lockCodeResult(tx, tenantId, inventoryId, resultId);
      const [activeMembership] = await tx
        .select({ id: schema.inventoryRepackItems.id })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.resultId, result.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (activeMembership) {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_ACTIVE_BOX_CONFLICT" });
      }
      const after = { ...result, observedProductionDate, updatedAt: changedAt };
      return {
        target: { eventId: null, codeResultId: result.id, repackBoxId: null },
        beforeProjectionDigest: inventoryProjectionDigest(codeResultProjection(result)),
        afterProjectionDigest: inventoryProjectionDigest(codeResultProjection(after)),
        effectAt: changedAt,
        apply: async () => {
          await tx
            .update(schema.inventoryCodeResults)
            .set({ observedProductionDate, updatedAt: changedAt })
            .where(
              and(
                eq(schema.inventoryCodeResults.tenantId, tenantId),
                eq(schema.inventoryCodeResults.inventoryId, inventoryId),
                eq(schema.inventoryCodeResults.id, result.id),
              ),
            );
          await this.recordProgressChange(
            tx,
            tenantId,
            inventoryId,
            snapshotId,
            nextRevision,
            after,
            changedAt,
          );
        },
      };
    }

    if (input.action === "remove_item") {
      const resultId = input.target.codeResultId;
      if (!resultId) throw new Error("Validated item correction has no code-result target");
      const [item] = await tx
        .select()
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.resultId, resultId),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!item) throw new NotFoundException({ code: "INVENTORY_CORRECTION_TARGET_NOT_FOUND" });
      const box = await this.lockRepackBox(tx, tenantId, inventoryId, item.boxId);
      if (box.state !== "open") {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_STATE_CONFLICT" });
      }
      const removedAt = item.addedAt > changedAt ? item.addedAt : changedAt;
      const after = { ...item, removedAt, activeObservedProductionDate: null };
      return {
        target: { eventId: null, codeResultId: resultId, repackBoxId: item.boxId },
        beforeProjectionDigest: inventoryProjectionDigest(repackItemProjection(item)),
        afterProjectionDigest: inventoryProjectionDigest(repackItemProjection(after)),
        effectAt: removedAt,
        apply: async () => {
          await tx
            .update(schema.inventoryRepackItems)
            .set({ removedAt, activeObservedProductionDate: null })
            .where(
              and(
                eq(schema.inventoryRepackItems.tenantId, tenantId),
                eq(schema.inventoryRepackItems.inventoryId, inventoryId),
                eq(schema.inventoryRepackItems.id, item.id),
              ),
            );
        },
      };
    }

    const boxId = input.target.repackBoxId;
    if (!boxId) throw new Error("Validated box correction has no box target");
    const box = await this.lockRepackBox(tx, tenantId, inventoryId, boxId);
    if (input.action === "invalidate_box") {
      if (box.state === "invalidated") {
        throw new ConflictException({ code: "INVENTORY_CORRECTION_STATE_CONFLICT" });
      }
      const after = {
        ...box,
        state: "invalidated" as const,
        invalidatedAt: changedAt,
        updatedAt: changedAt,
      };
      return {
        target: { eventId: null, codeResultId: null, repackBoxId: box.id },
        beforeProjectionDigest: inventoryProjectionDigest(repackBoxProjection(box)),
        afterProjectionDigest: inventoryProjectionDigest(repackBoxProjection(after)),
        effectAt: changedAt,
        apply: async () => {
          await tx
            .update(schema.inventoryRepackBoxes)
            .set({ state: "invalidated", invalidatedAt: changedAt, updatedAt: changedAt })
            .where(
              and(
                eq(schema.inventoryRepackBoxes.tenantId, tenantId),
                eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
                eq(schema.inventoryRepackBoxes.id, box.id),
              ),
            );
        },
      };
    }

    if (box.state !== "closed" || box.printState !== "printed") {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_STATE_CONFLICT" });
    }
    return {
      target: { eventId: null, codeResultId: null, repackBoxId: box.id },
      beforeProjectionDigest: inventoryProjectionDigest(repackBoxProjection(box)),
      afterProjectionDigest: inventoryProjectionDigest(repackBoxProjection(box)),
      effectAt: changedAt,
      apply: () => Promise.resolve(),
    };
  }

  private async lockCodeResult(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    resultId: string,
  ): Promise<CodeResult> {
    const [result] = await tx
      .select()
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          eq(schema.inventoryCodeResults.id, resultId),
        ),
      )
      .limit(1)
      .for("update");
    if (!result) throw new NotFoundException({ code: "INVENTORY_CORRECTION_TARGET_NOT_FOUND" });
    return result;
  }

  private async lockRepackBox(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    boxId: string,
  ): Promise<RepackBox> {
    const [box] = await tx
      .select()
      .from(schema.inventoryRepackBoxes)
      .where(
        and(
          eq(schema.inventoryRepackBoxes.tenantId, tenantId),
          eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
          eq(schema.inventoryRepackBoxes.id, boxId),
        ),
      )
      .limit(1)
      .for("update");
    if (!box) throw new NotFoundException({ code: "INVENTORY_CORRECTION_TARGET_NOT_FOUND" });
    return box;
  }

  private async recordProgressChange(
    tx: CorrectionTransaction,
    tenantId: string,
    inventoryId: string,
    snapshotId: string,
    resultRevision: number,
    result: CodeResult,
    changedAt: Date,
  ): Promise<void> {
    await tx.insert(schema.inventoryProgressChanges).values(
      inventoryProgressChangeRow({
        tenantId,
        inventoryId,
        snapshotId,
        resultRevision,
        result,
        changedAt,
      }),
    );
  }
}
