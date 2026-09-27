import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  finalizeTransformationSchema,
  platformUuidSchema,
  transformationFinalizedRecordSchema,
  type TransformationFinalizedRecord,
} from "@markiro/platform-contracts";
import { ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  parseMasterDataInput,
} from "../master-data/us-master-data-support";
import { lotResponse } from "../lots/us-lot-support";
import { bumpLotDependencyVersions } from "../lots/us-current-consumers";
import {
  lockTransformationOperation,
  transformationCommandDigest,
  transformationTransaction,
} from "./us-transformation-operations";
import {
  readTransformationDraft,
  readTransformationRecord,
  unavailable,
} from "./us-transformation-persistence";
import { readTransformationFinalizationContext } from "./us-transformation-readiness";
import { planTransformationSnapshot } from "./us-transformation-snapshot";
import { prepareTransformationRevision } from "./us-transformation-revision-effects";

export async function finalizeTransformation(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
): Promise<TransformationFinalizedRecord> {
  try {
    return await transformationTransaction(db, async (tx) => {
      const profileCode = await authorizeUsMasterData(
        tx,
        tenantId,
        actorUserId,
        US_CAPABILITY.QA_MANAGE,
      );
      const eventId = parseMasterDataInput(platformUuidSchema, id);
      const value = parseMasterDataInput(finalizeTransformationSchema, input);
      const command = "transformation.finalize",
        inputDigest = transformationCommandDigest(command, value, eventId);
      const receipt = await lockTransformationOperation(tx, tenantId, command, value.operationKey);
      if (receipt) {
        if (receipt.inputDigest !== inputDigest)
          throw new ConflictException({ code: "transformation_operation_conflict" });
        const parsed = transformationFinalizedRecordSchema.safeParse(receipt.result);
        if (!parsed.success || parsed.data.id !== eventId || receipt.eventId !== eventId)
          throw unavailable();
        return parsed.data;
      }
      const before = await readTransformationDraft(tx, tenantId, eventId, "update");
      if (before.draftVersion !== value.expectedDraftVersion)
        throw new ConflictException({ code: "transformation_draft_conflict" });
      const revision = await prepareTransformationRevision(tx, tenantId, before);
      const facts = await readTransformationFinalizationContext(
        tx,
        tenantId,
        before,
        profileCode,
        true,
      );
      if (facts.readiness.state !== "complete")
        throw new ConflictException({ code: "event_incomplete", issues: facts.readiness.issues });
      if (facts.readiness.inputDigest !== value.expectedInputDigest)
        throw new ConflictException({ code: "transformation_readiness_changed" });
      // Facts revalidated current origins after sorted input-lot locks. Publish a real
      // write even for permanently source-locked inputs so stale origin writers retry.
      await bumpLotDependencyVersions(tx, tenantId, revision.affectedLotIds);
      const now = new Date();
      const snapshot = planTransformationSnapshot(
        before,
        facts,
        actorUserId,
        now.toISOString(),
        revision.outputLotIds,
      );
      const lots = schema.traceabilityLots;
      // Stable source/TLC order also serializes unique-key collisions between independent roots.
      for (const output of [...snapshot.outputs].sort((a, b) =>
        a.tlc < b.tlc ? -1 : a.tlc > b.tlc ? 1 : 0,
      )) {
        if (before.revision > 1) continue;
        const [lot] = await tx
          .insert(lots)
          .values({
            id: output.lotId,
            tenantId,
            productId: output.product.id,
            tlc: output.tlc,
            sourceLocationId: snapshot.processor.id,
            assignmentBasis: "transformation",
            sourceLockedAt: now,
            createdBy: actorUserId,
            updatedBy: actorUserId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!lot) throw unavailable();
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "traceability.lot.created",
          outcome: "success",
          targetType: "traceability_lot",
          targetId: lot.id,
          before: null,
          after: { ...lotResponse(lot), eventId },
          requestId,
        });
      }
      // Preserve operational status and permanent existing locks on inputs.
      for (const lot of facts.lotRows) {
        if (lot.sourceLockedAt !== null) continue;
        const [locked] = await tx
          .update(lots)
          .set({
            sourceLockedAt: now,
            revision: lot.revision + 1,
            updatedBy: actorUserId,
            updatedAt: now,
          })
          .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lot.id)))
          .returning();
        if (!locked) throw unavailable();
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "traceability.lot.source_locked",
          outcome: "success",
          targetType: "traceability_lot",
          targetId: lot.id,
          before: lotResponse(lot),
          after: { ...lotResponse(locked), eventId },
          requestId,
        });
      }
      const outputs = schema.transformationEventOutputs;
      for (const output of snapshot.outputs) {
        await tx
          .update(outputs)
          .set({ lotId: output.lotId })
          .where(
            and(
              eq(outputs.tenantId, tenantId),
              eq(outputs.eventId, eventId),
              eq(outputs.lineNo, output.lineNo),
            ),
          );
        for (const input of snapshot.inputs)
          if (input.kind === "ftl_lot")
            await tx
              .insert(schema.lotGenealogyEdges)
              .values({ tenantId, eventId, inputLotId: input.lotId, outputLotId: output.lotId });
      }
      const events = schema.traceabilityEvents,
        roots = schema.transformationEventRoots;
      if (before.revision > 1) {
        if (!before.lifecycle?.previousRevisionId) throw unavailable();
        await tx
          .update(events)
          .set({
            status: "amended",
            supersededByEventId: eventId,
            supersededAt: now,
            supersededBy: actorUserId,
          })
          .where(
            and(
              eq(events.tenantId, tenantId),
              eq(events.id, before.lifecycle.previousRevisionId),
              eq(events.type, "transformation"),
            ),
          );
      }
      await tx
        .update(events)
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
            eq(events.tenantId, tenantId),
            eq(events.id, eventId),
            eq(events.type, "transformation"),
          ),
        );
      await tx
        .update(roots)
        .set({
          currentEventId: eventId,
          pendingDraftId: null,
          lifecycleVersion: (before.lifecycle?.lifecycleVersion ?? 1) + 1,
        })
        .where(
          and(eq(roots.tenantId, tenantId), eq(roots.id, before.lifecycle?.rootId ?? eventId)),
        );
      const result = await readTransformationRecord(tx, tenantId, eventId, "update");
      if (result.status !== "finalized") throw unavailable();
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.transformation.finalized",
        outcome: "success",
        targetType: "traceability_event",
        targetId: eventId,
        before,
        after: result,
        requestId,
      });
      await tx.insert(schema.transformationOperations).values({
        tenantId,
        command,
        operationKey: value.operationKey,
        inputDigest,
        eventId,
        result,
      });
      return result;
    });
  } catch (error) {
    if (
      [
        "traceability_lots_location_tlc_uq",
        "traceability_lots_reference_tlc_uq",
        "traceability_lots_missing_source_tlc_uq",
      ].some((name) => isUniqueConstraintViolation(error, name))
    )
      throw new ConflictException({ code: "transformation_lot_conflict" });
    throw error;
  }
}
