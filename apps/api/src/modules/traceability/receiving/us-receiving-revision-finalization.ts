import { schema, type Db } from "@markiro/db";
import {
  US_CAPABILITY,
  assessReceivingTransition,
  classifyReceivingAmendment,
  type ReceivingMaterialRevision,
} from "@markiro/domain";
import { ConflictException } from "@nestjs/common";
import {
  finalizeReceivingRevisionSchema,
  platformUuidSchema,
  receivingOperationReceiptV2Schema,
  type ReceivingFinalizationSnapshotV3,
  type ReceivingLiveRecord,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { lotResponse, lotSourceColumns } from "../lots/us-lot-support";
import {
  lockReceivingOperation,
  receivingLifecycleCommandDigest,
  receivingTransaction,
  replayReceivingLifecycle,
} from "./us-receiving-operations";
import { bumpReceivingBasisVersions, lockReceivingRoot } from "./us-receiving-roots";
import { readReceivingLiveRecord } from "./us-receiving-history";
import { readReceivingRevisionContext } from "./us-receiving-revision-readiness";
import { planReceivingRevisionSnapshot } from "./us-receiving-snapshots";
import { unavailable } from "./us-receiving-persistence";

type Context = Awaited<ReturnType<typeof readReceivingRevisionContext>>;
type Snapshot = Extract<ReceivingLiveRecord["content"], { kind: "finalized" }>["snapshot"];
function materialRevision(snapshot: Snapshot): ReceivingMaterialRevision {
  return {
    dateReceived: snapshot.dateReceived,
    locationId: snapshot.locationId,
    previousSourceLocationId: snapshot.previousSourceLocationId,
    lines: snapshot.items.map((line) => ({
      lineNo: line.lineNo,
      previousLineNo:
        "lotBinding" in line && line.lotBinding.kind === "retained"
          ? line.lotBinding.previousLineNo
          : null,
      lotId: line.lotId,
      productId: line.productId,
      lotLinkMode: line.lotLinkMode,
      effectiveTlc: line.tlc,
      source: line.source,
      receiptHandling: "receiptBasis" in line ? line.receiptBasis.kind : "ordinary",
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
  };
}
const mapping = (snapshot: Snapshot) =>
  snapshot.items.map((line) => ({ lineNo: line.lineNo, lotId: line.lotId }));
const lotIdentity = (line: ReceivingFinalizationSnapshotV3["items"][number]) =>
  JSON.stringify([
    line.tlc,
    line.source.kind,
    ...(line.source.kind === "location"
      ? [line.source.locationId]
      : [line.source.referenceKind, line.source.referenceValue]),
  ]);

/** Only new unbound lines allocate/latch lots. Retained and removed lots are immutable here. */
async function persistLots(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  eventId: string,
  requestId: string,
  now: Date,
  context: Context,
  snapshot: ReceivingFinalizationSnapshotV3,
) {
  const lots = schema.traceabilityLots;
  for (const line of snapshot.items
    .filter((line) => line.lotBinding.kind === "created")
    .sort((a, b) =>
      lotIdentity(a) < lotIdentity(b) ? -1 : lotIdentity(a) > lotIdentity(b) ? 1 : 0,
    )) {
    const [row] = await tx
      .insert(lots)
      .values({
        id: line.lotId,
        tenantId,
        productId: line.productId,
        tlc: line.tlc,
        ...lotSourceColumns(line.source),
        assignmentBasis:
          line.receiptBasis.kind === "exempt_assigned_tlc" ? "exempt_supplier_receipt" : "imported",
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
  const priorIds = new Set(context.working.predecessor?.draft.items.map((line) => line.lotId));
  const newlyLinkedIds = new Set(
    snapshot.items.filter((line) => line.lotBinding.kind === "linked").map((line) => line.lotId),
  );
  for (const row of context.facts.lotRows) {
    if (row.sourceLockedAt !== null) continue;
    if (priorIds.has(row.id)) throw unavailable();
    if (!newlyLinkedIds.has(row.id)) continue;
    if (row.revision >= 2_147_483_647) throw unavailable();
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
}

/** Internal explicit-v2 command. Legacy HTTP input, digests and result formats are untouched. */
export async function finalizeReceivingRevision(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
) {
  try {
    return await receivingTransaction(db, async (tx) => {
      const profileCode = await authorizeUsMasterData(
        tx,
        tenantId,
        actorUserId,
        US_CAPABILITY.QA_MANAGE,
      );
      const eventId = parseMasterDataInput(platformUuidSchema, id);
      const value = parseMasterDataInput(finalizeReceivingRevisionSchema, input);
      const command = "receiving.finalize";
      const inputDigest = receivingLifecycleCommandDigest(command, eventId, value);
      const stored = await lockReceivingOperation(tx, tenantId, command, value.operationKey);
      if (stored)
        return replayReceivingLifecycle(stored, command, eventId, value.operationKey, inputDigest);
      const root = await lockReceivingRoot(tx, tenantId, eventId);
      const events = schema.traceabilityEvents,
        roots = schema.receivingEventRoots;
      await tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
        .for("update");
      const before = await readReceivingLiveRecord(tx, tenantId, eventId);
      const decision = assessReceivingTransition(
        {
          id: before.id,
          rootId: root.id,
          status: before.status,
          revision: before.revision,
          supersededByEventId: before.lifecycle.supersededByEventId,
          currentEventId: root.currentEventId,
          pendingDraftId: root.pendingDraftId,
          lifecycleVersion: root.lifecycleVersion,
          nextRevision: root.nextRevision,
        },
        "finalize",
      );
      if (
        !decision.ok ||
        root.lifecycleVersion !== value.expectedLifecycleVersion ||
        before.lifecycle.previousRevisionId !== value.previousRevisionId
      )
        throw new ConflictException({
          code: "receiving_lifecycle_conflict",
          rootId: root.id,
          lifecycleVersion: root.lifecycleVersion,
          currentEventId: root.currentEventId,
          pendingDraftId: root.pendingDraftId,
        });
      if (before.draftVersion !== value.expectedDraftVersion)
        throw new ConflictException({ code: "receiving_draft_conflict" });
      if (value.previousRevisionId !== null)
        await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.tenantId, tenantId), eq(events.id, value.previousRevisionId)))
          .for("update");
      // Root and both revision rows precede sorted lot and reference locks.
      // The same projection produces the read-only check and this locked digest.
      const context = await readReceivingRevisionContext(
        tx,
        tenantId,
        eventId,
        value.expectedDraftVersion,
        profileCode,
        true,
      );
      if (context.readiness.state !== "complete")
        throw new ConflictException({ code: "event_incomplete", issues: context.readiness.issues });
      if (context.readiness.inputDigest !== value.expectedInputDigest)
        throw new ConflictException({ code: "receiving_readiness_changed" });
      const required = context.readiness.exemptReviewRequiredLines,
        reviewed = value.reviewedExemptLines;
      if (
        required.length !== reviewed.length ||
        required.some((line, index) => line !== reviewed[index])
      ) {
        const mismatched = [...new Set([...required, ...reviewed])]
          .filter((line) => required.includes(line) !== reviewed.includes(line))
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
      const snapshot = planReceivingRevisionSnapshot(context, {
        actorUserId,
        finalizedAt: now.toISOString(),
        reviewedExemptLines: reviewed,
      });
      const predecessor = context.working.predecessor?.record ?? null;
      if (predecessor && predecessor.content.kind !== "finalized") throw unavailable();
      const priorSnapshot =
        predecessor?.content.kind === "finalized" ? predecessor.content.snapshot : null;
      const effect = priorSnapshot
        ? classifyReceivingAmendment(materialRevision(priorSnapshot), materialRevision(snapshot))
        : null;
      if (effect && (effect.invalidBindingLineNos.length || effect.identityLockedLineNos.length))
        throw unavailable();
      // Context established complete Receiving-only integrity under lot coordination.
      // Other CTEs must register real dependency writers before becoming supported.
      await persistLots(tx, tenantId, actorUserId, eventId, requestId, now, context, snapshot);
      const items = schema.receivingEventItems;
      for (const line of snapshot.items) {
        const [written] = await tx
          .update(items)
          .set({ lotId: line.lotId })
          .where(
            and(
              eq(items.tenantId, tenantId),
              eq(items.eventId, eventId),
              eq(items.lineNo, line.lineNo),
            ),
          )
          .returning({ lineNo: items.lineNo });
        if (!written) throw unavailable();
      }
      if (predecessor)
        await tx
          .update(events)
          .set({
            status: "amended",
            supersededByEventId: eventId,
            supersededAt: now,
            supersededBy: actorUserId,
          })
          .where(and(eq(events.tenantId, tenantId), eq(events.id, predecessor.id)));
      await tx
        .update(events)
        .set({
          status: "finalized",
          finalizedAt: now,
          finalizedBy: actorUserId,
          finalizationSnapshot: snapshot,
          updatedAt: now,
          updatedBy: actorUserId,
        })
        .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)));
      await tx
        .update(roots)
        .set({
          currentEventId: eventId,
          pendingDraftId: null,
          lifecycleVersion: root.lifecycleVersion + 1,
        })
        .where(and(eq(roots.tenantId, tenantId), eq(roots.id, root.id)));
      await bumpReceivingBasisVersions(tx, tenantId, [
        ...context.basis.map((lot) => lot.lotId),
        ...snapshot.items.map((line) => line.lotId),
      ]);
      const after = await readReceivingLiveRecord(tx, tenantId, eventId);
      const predecessorAfter = predecessor
        ? await readReceivingLiveRecord(tx, tenantId, predecessor.id)
        : null;
      const parsed = receivingOperationReceiptV2Schema.safeParse({
        receiptVersion: 2,
        command,
        operationKey: value.operationKey,
        inputDigest,
        eventId,
        record: after,
      });
      if (!parsed.success) throw unavailable();
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.receiving.finalized",
        outcome: "success",
        targetType: "traceability_event",
        targetId: eventId,
        before,
        after: {
          rootId: root.id,
          revision: after.revision,
          reason: after.lifecycle.amendmentReason,
          result: "finalized",
          effect,
          record: after,
          predecessor: predecessor ? { before: predecessor, after: predecessorAfter } : null,
          lineLots: {
            before: priorSnapshot ? mapping(priorSnapshot) : [],
            after: mapping(snapshot),
          },
        },
        requestId,
      });
      await tx.insert(schema.receivingOperations).values({
        tenantId,
        command,
        operationKey: value.operationKey,
        inputDigest,
        eventId,
        result: parsed.data,
      });
      return parsed.data;
    });
  } catch (error) {
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
