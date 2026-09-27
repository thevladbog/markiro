import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY, sameTransformationOutputIdentity } from "@markiro/domain";
import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  createTransformationDraftSchema,
  saveTransformationDraftSchema,
  platformUuidSchema,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import {
  lockTransformationOperation,
  replayTransformationDraft,
  transformationCommandDigest,
  transformationTransaction,
} from "./us-transformation-operations";
import {
  readTransformationDraft,
  readTransformationRecord,
  replaceTransformationChildren,
  transformationHeader,
  unavailable,
} from "./us-transformation-persistence";
import { assertTransformationReferences } from "./us-transformation-reference-context";

export function createTransformationDraft(
  db: Db,
  tenantId: string,
  actorUserId: string,
  input: unknown,
  requestId: string,
) {
  return transformationTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.TRANSFORMATION_WRITE);
    const value = parseMasterDataInput(createTransformationDraftSchema, input);
    const command = "transformation.create",
      inputDigest = transformationCommandDigest(command, value);
    const stored = await lockTransformationOperation(tx, tenantId, command, value.operationKey);
    if (stored) return replayTransformationDraft(stored, inputDigest);
    await assertTransformationReferences(tx, tenantId, value.draft);
    const [profile] = await tx
      .select()
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile) throw unavailable();
    const now = new Date(),
      year = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: profile.timeZone, year: "numeric" }).format(
          now,
        ),
      );
    const counters = schema.transformationCounters;
    const [counter] = await tx
      .insert(counters)
      .values({ tenantId, year, sequence: 1 })
      .onConflictDoUpdate({
        target: [counters.tenantId, counters.year],
        set: { sequence: sql`${counters.sequence} + 1` },
      })
      .returning();
    if (!counter) throw unavailable();
    const eventId = randomUUID(),
      eventNumber = `TRN-${String(year).slice(-2).padStart(2, "0")}-${String(counter.sequence).padStart(4, "0")}`;
    await tx
      .insert(schema.transformationEventRoots)
      .values({ tenantId, id: eventId, eventNumber, pendingDraftId: eventId });
    await tx.insert(schema.traceabilityEvents).values({
      ...transformationHeader(value.draft),
      id: eventId,
      rootEventId: eventId,
      type: "transformation",
      tenantId,
      eventNumber,
      timeZone: profile.timeZone,
      createdBy: actorUserId,
      updatedBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    await replaceTransformationChildren(tx, tenantId, eventId, value.draft);
    const result = await readTransformationDraft(tx, tenantId, eventId, "update");
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "traceability.transformation.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      targetId: eventId,
      before: null,
      after: result,
      requestId,
    });
    await tx.insert(schema.transformationOperations).values({
      tenantId,
      eventId,
      command,
      operationKey: value.operationKey,
      inputDigest,
      result,
    });
    return result;
  });
}
export function saveTransformationDraft(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return transformationTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.TRANSFORMATION_WRITE);
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const events = schema.traceabilityEvents;
    const [identity] = await tx
      .select({ revision: events.revision })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.id, eventId),
          eq(events.type, "transformation"),
        ),
      );
    if (!identity) throw new NotFoundException({ code: "transformation_not_found" });
    if (identity.revision > 1)
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
    const value = parseMasterDataInput(saveTransformationDraftSchema, input);
    const command = "transformation.save",
      inputDigest = transformationCommandDigest(command, value, eventId);
    const stored = await lockTransformationOperation(tx, tenantId, command, value.operationKey);
    if (stored) return replayTransformationDraft(stored, inputDigest, eventId);
    const before = await readTransformationDraft(tx, tenantId, eventId, "update");
    if (before.draftVersion !== value.expectedDraftVersion || before.draftVersion === 2147483647)
      throw new ConflictException({ code: "transformation_draft_conflict" });
    let boundOutputLotIds: string[] | undefined;
    if (before.revision > 1) {
      const predecessorId = before.lifecycle?.previousRevisionId;
      if (!predecessorId || before.lifecycle?.currentEventId !== predecessorId) throw unavailable();
      const predecessor = await readTransformationRecord(tx, tenantId, predecessorId, "share");
      if (predecessor.status !== "finalized") throw unavailable();
      if (
        value.draft.processorLocationId !== predecessor.snapshot.processor.id ||
        !sameTransformationOutputIdentity(
          predecessor.snapshot.outputs.map((line) => ({
            productId: line.product.id,
            tlc: line.tlc,
            quantity: line.quantity,
            unitOfMeasure: line.unitOfMeasure,
          })),
          value.draft.outputs,
        )
      )
        throw new ConflictException({ code: "transformation_output_identity_locked" });
      boundOutputLotIds = predecessor.snapshot.outputs.map((line) => line.lotId);
    }
    await assertTransformationReferences(tx, tenantId, value.draft);
    await tx
      .update(events)
      .set({
        ...transformationHeader(value.draft),
        draftVersion: before.draftVersion + 1,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.id, eventId),
          eq(events.type, "transformation"),
        ),
      );
    await replaceTransformationChildren(tx, tenantId, eventId, value.draft, boundOutputLotIds);
    const result = await readTransformationDraft(tx, tenantId, eventId, "update");
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "traceability.transformation.draft_saved",
      outcome: "success",
      targetType: "traceability_event",
      targetId: eventId,
      before,
      after: result,
      requestId,
    });
    await tx.insert(schema.transformationOperations).values({
      tenantId,
      eventId,
      command,
      operationKey: value.operationKey,
      inputDigest,
      result,
    });
    return result;
  });
}
