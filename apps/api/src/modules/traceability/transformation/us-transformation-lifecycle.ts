import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { ConflictException } from "@nestjs/common";
import {
  amendTransformationSchema,
  platformUuidSchema,
  transformationLifecycleReceiptSchema,
  voidTransformationSchema,
} from "@markiro/platform-contracts";
import { and, asc, eq } from "drizzle-orm";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { bumpLotDependencyVersions } from "../lots/us-current-consumers";
import {
  assertNoTransformationConsumers,
  lockTransformationLots,
} from "./us-transformation-revision-effects";
import {
  lockTransformationOperation,
  transformationCommandDigest,
  transformationTransaction,
} from "./us-transformation-operations";
import {
  readTransformationRecord,
  readTransformationSavedDraft,
  replaceTransformationChildren,
  transformationHeader,
  unavailable,
} from "./us-transformation-persistence";

const events = schema.traceabilityEvents;
const roots = schema.transformationEventRoots;

/** Internal revision lifecycle; immutable evidence survives every transition. */
export function executeTransformationLifecycle(
  db: Db,
  tenantId: string,
  actorUserId: string,
  command: "transformation.amend" | "transformation.void",
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return transformationTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const value =
      command === "transformation.amend"
        ? parseMasterDataInput(amendTransformationSchema, input)
        : parseMasterDataInput(voidTransformationSchema, input);
    const inputDigest = transformationCommandDigest(command, value, eventId);
    const stored = await lockTransformationOperation(tx, tenantId, command, value.operationKey);
    if (stored) {
      if (stored.inputDigest !== inputDigest)
        throw new ConflictException({ code: "transformation_operation_conflict" });
      const parsed = transformationLifecycleReceiptSchema.safeParse(stored.result);
      if (
        !parsed.success ||
        parsed.data.eventId !== stored.eventId ||
        (command === "transformation.void" && parsed.data.eventId !== eventId)
      )
        throw unavailable();
      return parsed.data;
    }
    const before = await readTransformationRecord(tx, tenantId, eventId, "update");
    const lifecycle = before.lifecycle;
    if (!lifecycle || lifecycle.lifecycleVersion !== value.expectedLifecycleVersion)
      throw new ConflictException({ code: "transformation_lifecycle_conflict" });

    let resultId: string;
    if (command === "transformation.amend") {
      if (before.status !== "finalized" || lifecycle.currentEventId !== eventId)
        throw new ConflictException({ code: "transformation_lifecycle_conflict" });
      if (lifecycle.pendingDraftId)
        throw new ConflictException({
          code: "transformation_pending_amendment",
          pendingDraftId: lifecycle.pendingDraftId,
        });
      const [root] = await tx
        .select()
        .from(roots)
        .where(and(eq(roots.tenantId, tenantId), eq(roots.id, lifecycle.rootId)));
      const [header] = await tx
        .select()
        .from(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)));
      if (!root || !header || root.nextRevision >= 2147483647) throw unavailable();
      const draft = await readTransformationSavedDraft(tx, tenantId, eventId, header);
      const outputRows = await tx
        .select()
        .from(schema.transformationEventOutputs)
        .where(
          and(
            eq(schema.transformationEventOutputs.tenantId, tenantId),
            eq(schema.transformationEventOutputs.eventId, eventId),
          ),
        )
        .orderBy(asc(schema.transformationEventOutputs.lineNo));
      const boundOutputLotIds = outputRows.map((line) => {
        if (!line.lotId) throw unavailable();
        return line.lotId;
      });
      if (boundOutputLotIds.length !== draft.outputs.length) throw unavailable();
      const now = new Date();
      resultId = randomUUID();
      await tx.insert(events).values({
        ...transformationHeader(draft),
        id: resultId,
        rootEventId: root.id,
        type: "transformation",
        tenantId,
        eventNumber: root.eventNumber,
        revision: root.nextRevision,
        previousRevisionId: eventId,
        amendmentReason: value.reason,
        timeZone: header.timeZone,
        createdBy: actorUserId,
        updatedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceTransformationChildren(tx, tenantId, resultId, draft, boundOutputLotIds);
      await tx
        .update(roots)
        .set({
          pendingDraftId: resultId,
          nextRevision: root.nextRevision + 1,
          lifecycleVersion: root.lifecycleVersion + 1,
        })
        .where(and(eq(roots.tenantId, tenantId), eq(roots.id, root.id)));
    } else {
      if (before.status === "draft") {
        if (
          lifecycle.pendingDraftId !== eventId ||
          (before.revision === 1 && lifecycle.currentEventId !== null)
        )
          throw new ConflictException({ code: "transformation_lifecycle_conflict" });
        if (
          !("expectedDraftVersion" in value) ||
          value.expectedDraftVersion !== before.draftVersion
        )
          throw new ConflictException({ code: "transformation_draft_conflict" });
      } else if (before.status === "finalized" && lifecycle.currentEventId === eventId) {
        if (lifecycle.pendingDraftId)
          throw new ConflictException({
            code: "transformation_pending_amendment",
            pendingDraftId: lifecycle.pendingDraftId,
          });
        if ("expectedDraftVersion" in value)
          throw new ConflictException({ code: "transformation_draft_conflict" });
        const outputs = before.snapshot.outputs.map((line) => line.lotId);
        const affected = [
          ...outputs,
          ...before.snapshot.inputs.flatMap((line) =>
            line.kind === "ftl_lot" ? [line.lotId] : [],
          ),
        ];
        await lockTransformationLots(tx, tenantId, affected);
        await assertNoTransformationConsumers(tx, tenantId, outputs);
        await bumpLotDependencyVersions(tx, tenantId, affected);
      } else {
        throw new ConflictException({ code: "transformation_lifecycle_conflict" });
      }
      resultId = eventId;
      await tx
        .update(events)
        .set({
          status: "void",
          voidedAt: new Date(),
          voidedBy: actorUserId,
          voidReason: value.reason,
        })
        .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)));
      await tx
        .update(roots)
        .set({
          ...(before.status === "draft" ? { pendingDraftId: null } : { currentEventId: null }),
          lifecycleVersion: lifecycle.lifecycleVersion + 1,
        })
        .where(and(eq(roots.tenantId, tenantId), eq(roots.id, lifecycle.rootId)));
    }
    const after = await readTransformationRecord(tx, tenantId, resultId, "update");
    const parsed = transformationLifecycleReceiptSchema.safeParse({
      receiptVersion: 1,
      command,
      operationKey: value.operationKey,
      inputDigest,
      eventId: resultId,
      record: after,
    });
    if (!parsed.success) throw unavailable();
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action:
        command === "transformation.amend"
          ? "traceability.transformation.amendment_started"
          : "traceability.transformation.voided",
      outcome: "success",
      targetType: "traceability_event",
      targetId: resultId,
      before,
      after: {
        rootId: lifecycle.rootId,
        revision: after.revision,
        reason: value.reason,
        result: command === "transformation.amend" ? "draft_started" : "voided",
        record: after,
      },
      requestId,
    });
    await tx.insert(schema.transformationOperations).values({
      tenantId,
      eventId: resultId,
      command,
      operationKey: value.operationKey,
      inputDigest,
      result: parsed.data,
    });
    return parsed.data;
  });
}
