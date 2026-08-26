import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type {
  CreateInventoryCorrectionDto,
  InventoryCorrectionDto,
  InventoryCorrectionTargetDto,
} from "./dto";

type CorrectionTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type StoredCorrection = typeof schema.inventoryCorrections.$inferSelect;
type CodeResult = typeof schema.inventoryCodeResults.$inferSelect;
type RepackBox = typeof schema.inventoryRepackBoxes.$inferSelect;
type RepackItem = typeof schema.inventoryRepackItems.$inferSelect;

function digest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function correctionId(tenantId: string, inventoryId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update("markiro:inventory-correction:v1\0", "utf8")
    .update(tenantId, "utf8")
    .update("\0", "utf8")
    .update(inventoryId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Correction identity digest is shorter than a UUID");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codeResultProjection(
  result: Pick<CodeResult, "id" | "classification" | "observedProductionDate">,
) {
  return {
    kind: "code_result",
    id: result.id,
    classification: result.classification,
    observedProductionDate: result.observedProductionDate,
  };
}

function repackBoxProjection(
  box: Pick<RepackBox, "id" | "state" | "printState" | "printAttemptCount" | "productionDate">,
) {
  return {
    kind: "repack_box",
    id: box.id,
    state: box.state,
    printState: box.printState,
    printAttemptCount: box.printAttemptCount,
    productionDate: box.productionDate,
  };
}

function repackItemProjection(item: Pick<RepackItem, "id" | "boxId" | "resultId" | "removedAt">) {
  return {
    kind: "repack_item",
    id: item.id,
    boxId: item.boxId,
    resultId: item.resultId,
    active: item.removedAt === null,
  };
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

    const id = correctionId(tenantId, inventoryId, input.idempotencyKey);
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
      if (!this.isExactReplay(existing, input)) {
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
    const createdAt = new Date();
    const prepared = await this.prepareMutation(
      tx,
      tenantId,
      inventoryId,
      inventory.activeSnapshotId,
      nextRevision,
      input,
      createdAt,
    );
    const [correction] = await tx
      .insert(schema.inventoryCorrections)
      .values({
        id,
        tenantId,
        inventoryId,
        action: input.action,
        reason: input.reason,
        actorUserId,
        targetEventId: prepared.target.eventId,
        targetCodeResultId: prepared.target.codeResultId,
        targetRepackBoxId: prepared.target.repackBoxId,
        beforeProjectionDigest: prepared.beforeProjectionDigest,
        afterProjectionDigest: prepared.afterProjectionDigest,
        resultRevision: nextRevision,
        createdAt,
      })
      .returning();
    if (!correction) throw new Error("Inventory correction insert returned no row");

    await prepared.apply();
    await tx
      .update(schema.inventories)
      .set({ resultRevision: nextRevision, updatedAt: createdAt })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    return toDto(correction);
  }

  private isExactReplay(existing: StoredCorrection, input: CreateInventoryCorrectionDto): boolean {
    const targetMatches =
      input.target.eventId !== undefined
        ? existing.targetEventId === input.target.eventId
        : input.target.codeResultId !== undefined
          ? existing.targetCodeResultId === input.target.codeResultId
          : existing.targetRepackBoxId === input.target.repackBoxId;
    return (
      existing.action === input.action &&
      existing.reason === input.reason &&
      existing.resultRevision === input.expectedResultRevision + 1 &&
      targetMatches
    );
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
      const after = { ...result, classification };
      return {
        target: { eventId, codeResultId: result.id, repackBoxId: null },
        beforeProjectionDigest: digest(codeResultProjection(result)),
        afterProjectionDigest: digest(codeResultProjection(after)),
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
      const after = { ...result, observedProductionDate };
      return {
        target: { eventId: null, codeResultId: result.id, repackBoxId: null },
        beforeProjectionDigest: digest(codeResultProjection(result)),
        afterProjectionDigest: digest(codeResultProjection(after)),
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
      const removedAt = new Date(Math.max(changedAt.getTime(), item.addedAt.getTime()) + 1);
      const after = { ...item, removedAt };
      return {
        target: { eventId: null, codeResultId: resultId, repackBoxId: item.boxId },
        beforeProjectionDigest: digest(repackItemProjection(item)),
        afterProjectionDigest: digest(repackItemProjection(after)),
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
      const after = { ...box, state: "invalidated" as const };
      return {
        target: { eventId: null, codeResultId: null, repackBoxId: box.id },
        beforeProjectionDigest: digest(repackBoxProjection(box)),
        afterProjectionDigest: digest(repackBoxProjection(after)),
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

    if (box.state !== "closed") {
      throw new ConflictException({ code: "INVENTORY_CORRECTION_STATE_CONFLICT" });
    }
    const after = { ...box, printState: "pending" as const };
    return {
      target: { eventId: null, codeResultId: null, repackBoxId: box.id },
      beforeProjectionDigest: digest(repackBoxProjection(box)),
      afterProjectionDigest: digest(repackBoxProjection(after)),
      apply: async () => {
        await tx
          .update(schema.inventoryRepackBoxes)
          .set({
            printState: "pending",
            printErrorCode: null,
            printedAt: null,
            updatedAt: changedAt,
          })
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
    await tx.insert(schema.inventoryProgressChanges).values({
      tenantId,
      inventoryId,
      snapshotId,
      resultRevision,
      kind: "correction",
      codeHash: result.codeHash,
      classification: result.classification,
      observedProductionDate: result.observedProductionDate,
      winningEventId: result.firstAcceptedEventId,
      winningDeviceId: result.winningDeviceId,
      winningScannedAt: result.winningScannedAt,
      changedAt,
    });
  }
}
