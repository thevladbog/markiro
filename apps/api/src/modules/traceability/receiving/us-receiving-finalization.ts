import { ConflictException } from "@nestjs/common";
import { US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  finalizeReceivingSchema,
  platformUuidSchema,
  receivingFinalizedRecordSchema,
  type ReceivingFinalizedRecord,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  parseMasterDataInput,
} from "../master-data/us-master-data-support";
import { lotResponse, lotSourceColumns } from "../lots/us-lot-support";
import { readReceivingDraft, readReceivingRecord, unavailable } from "./us-receiving-persistence";
import { readReceivingReferenceContext } from "./us-receiving-reference-context";
import { planReceivingSnapshot } from "./us-receiving-snapshots";
import { receivingFinalizationCommandDigest } from "./us-receiving-finalization-command";
import { lockReceivingOperation } from "./us-receiving-operations";
import {
  bumpReceivingBasisVersions,
  finalizeOriginalReceivingRoot,
  lockReceivingRoot,
} from "./us-receiving-roots";

function retryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error.code === "40001" || error.code === "40P01")) return true;
  return "cause" in error && retryable(error.cause);
}
const identity = (line: ReceivingFinalizedRecord["snapshot"]["items"][number]) =>
  JSON.stringify([
    line.tlc,
    line.source.kind,
    ...(line.source.kind === "location"
      ? [line.source.locationId]
      : [line.source.referenceKind, line.source.referenceValue]),
  ]);

export async function finalizeReceiving(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
): Promise<ReceivingFinalizedRecord> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const profileCode = await authorizeUsMasterData(
            tx,
            tenantId,
            actorUserId,
            US_CAPABILITY.QA_MANAGE,
          );
          const eventId = parseMasterDataInput(platformUuidSchema, id);
          const value = parseMasterDataInput(finalizeReceivingSchema, input);
          const inputDigest = receivingFinalizationCommandDigest(eventId, value);
          const operations = schema.receivingOperations;
          const receipt = await lockReceivingOperation(
            tx,
            tenantId,
            "receiving.finalize",
            value.operationKey,
          );
          if (receipt) {
            if (receipt.inputDigest !== inputDigest)
              throw new ConflictException({ code: "receiving_operation_conflict" });
            const result = receivingFinalizedRecordSchema.safeParse(receipt.result);
            if (!result.success || result.data.id !== eventId || receipt.eventId !== eventId)
              throw unavailable();
            return result.data;
          }
          await lockReceivingRoot(tx, tenantId, eventId);
          const before = await readReceivingDraft(tx, tenantId, eventId, "update");
          if (before.draftVersion !== value.expectedDraftVersion)
            throw new ConflictException({ code: "receiving_draft_conflict" });
          const context = await readReceivingReferenceContext(
            tx,
            tenantId,
            before,
            profileCode,
            true,
          );
          if (context.readiness.state !== "complete")
            throw new ConflictException({
              code: "event_incomplete",
              issues: context.readiness.issues,
            });
          if (context.readiness.inputDigest !== value.expectedInputDigest)
            throw new ConflictException({ code: "receiving_readiness_changed" });
          const expected = context.readiness.exemptReviewRequiredLines;
          const reviewed = value.reviewedExemptLines ?? [];
          if (
            reviewed.length !== expected.length ||
            reviewed.some((line, index) => line !== expected[index])
          ) {
            const mismatched = [...new Set([...expected, ...reviewed])]
              .filter((line) => expected.includes(line) !== reviewed.includes(line))
              .sort((a, b) => a - b);
            throw new ConflictException({
              code: "event_incomplete",
              issues: mismatched.map((line) => ({
                severity: "error",
                group: "lines",
                line,
                field: "exemption",
                code: "exemption_review_required",
                detail: null,
              })),
            });
          }
          const now = new Date();
          const snapshot = planReceivingSnapshot(before, context, {
            actorUserId,
            finalizedAt: now.toISOString(),
            reviewedExemptLines: reviewed,
          });
          const lots = schema.traceabilityLots;
          for (const line of snapshot.items
            .filter((line) => line.lotLinkMode === "create_on_finalize")
            .sort((a, b) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0))) {
            const [row] = await tx
              .insert(lots)
              .values({
                id: line.lotId,
                tenantId,
                productId: line.productId,
                tlc: line.tlc,
                ...lotSourceColumns(line.source),
                assignmentBasis:
                  line.receiptBasis.kind === "exempt_assigned_tlc"
                    ? "exempt_supplier_receipt"
                    : "imported",
                sourceLockedAt: now,
                createdBy: actorUserId,
                updatedBy: actorUserId,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            if (!row) throw unavailable();
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId,
              action: "traceability.lot.created",
              outcome: "success",
              targetType: "traceability_lot",
              targetId: row.id,
              before: null,
              after: { ...lotResponse(row), eventId },
              requestId,
            });
          }
          for (const row of context.lotRows) {
            if (row.sourceLockedAt !== null) continue;
            const [updated] = await tx
              .update(lots)
              .set({
                sourceLockedAt: now,
                revision: row.revision + 1,
                updatedBy: actorUserId,
                updatedAt: now,
                lastStatusReason: null,
                lastSourceReason: null,
              })
              .where(and(eq(lots.tenantId, tenantId), eq(lots.id, row.id)))
              .returning();
            if (!updated) throw unavailable();
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId,
              action: "traceability.lot.source_locked",
              outcome: "success",
              targetType: "traceability_lot",
              targetId: row.id,
              before: lotResponse(row),
              after: { ...lotResponse(updated), eventId },
              requestId,
            });
          }
          for (const line of snapshot.items)
            await tx
              .update(schema.receivingEventItems)
              .set({ lotId: line.lotId })
              .where(
                and(
                  eq(schema.receivingEventItems.tenantId, tenantId),
                  eq(schema.receivingEventItems.eventId, eventId),
                  eq(schema.receivingEventItems.lineNo, line.lineNo),
                ),
              );
          await tx
            .update(schema.traceabilityEvents)
            .set({
              status: "finalized",
              finalizedAt: now,
              finalizedBy: actorUserId,
              finalizationSnapshot: snapshot,
              updatedBy: actorUserId,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.traceabilityEvents.tenantId, tenantId),
                eq(schema.traceabilityEvents.id, eventId),
              ),
            );
          await finalizeOriginalReceivingRoot(tx, tenantId, eventId);
          await bumpReceivingBasisVersions(
            tx,
            tenantId,
            snapshot.items.map((line) => line.lotId),
          );
          const after = await readReceivingRecord(tx, tenantId, eventId, "update");
          if (after.status !== "finalized") throw unavailable();
          await tx.insert(schema.tenantAuditEvents).values({
            organizationId: tenantId,
            actorUserId,
            action: "traceability.receiving.finalized",
            outcome: "success",
            targetType: "traceability_event",
            targetId: eventId,
            before,
            after,
            requestId,
          });
          await tx.insert(operations).values({
            tenantId,
            command: "receiving.finalize",
            operationKey: value.operationKey,
            inputDigest,
            eventId,
            result: after,
          });
          return after;
        },
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      if (retryable(error)) {
        if (attempt < 2) continue;
        throw unavailable();
      }
      if (
        [
          "traceability_lots_location_tlc_uq",
          "traceability_lots_reference_tlc_uq",
          "traceability_lots_missing_source_tlc_uq",
        ].some((name) => isUniqueConstraintViolation(error, name))
      )
        throw new ConflictException({ code: "receiving_lot_conflict" });
      throw error;
    }
  }
  throw unavailable();
}
