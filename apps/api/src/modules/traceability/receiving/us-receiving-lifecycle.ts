import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { ConflictException } from "@nestjs/common";
import { US_CAPABILITY, assessReceivingTransition } from "@markiro/domain";
import {
  amendReceivingSchema,
  voidReceivingSchema,
  platformUuidSchema,
  receivingOperationReceiptV2Schema,
  type ReceivingLiveRecord,
} from "@markiro/platform-contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";
import { receivingHeader, unavailable } from "./us-receiving-persistence";
import {
  bumpReceivingBasisVersions,
  lockReceivingRoot,
  type ReceivingRootRow,
} from "./us-receiving-roots";
import {
  lockReceivingOperation,
  receivingLifecycleCommandDigest,
  receivingTransaction,
  replayReceivingLifecycle,
} from "./us-receiving-operations";
import { readReceivingBasis } from "./us-receiving-basis";

const events = schema.traceabilityEvents,
  roots = schema.receivingEventRoots;

function conflict(before: ReceivingLiveRecord) {
  return new ConflictException({
    code: "receiving_lifecycle_conflict",
    rootId: before.lifecycle.rootId,
    lifecycleVersion: before.lifecycle.lifecycleVersion,
    currentEventId: before.lifecycle.currentEventId,
    pendingDraftId: before.lifecycle.pendingDraftId,
  });
}

async function startAmendment(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  root: ReceivingRootRow,
  before: ReceivingLiveRecord,
  reason: string,
) {
  // Copy immutable saved inputs, including exact source and received/proposed TLC.
  // Live reference validity and fresh QA review belong to save/readiness/finalize.
  const [header] = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, before.id)));
  if (!header) throw unavailable();
  const items = schema.receivingEventItems,
    documents = schema.receivingEventDocuments;
  const lines = await tx
    .select()
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.eventId, before.id)))
    .orderBy(asc(items.lineNo));
  const links = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.eventId, before.id)))
    .orderBy(asc(documents.position));
  const id = randomUUID(),
    now = new Date();
  await tx.insert(events).values({
    ...receivingHeader(header),
    id,
    tenantId,
    rootEventId: root.id,
    eventNumber: root.eventNumber,
    revision: root.nextRevision,
    previousRevisionId: before.id,
    amendmentReason: reason,
    timeZone: before.timeZone,
    createdBy: actorUserId,
    updatedBy: actorUserId,
    createdAt: now,
    updatedAt: now,
  });
  if (lines.length)
    await tx
      .insert(items)
      .values(lines.map((line) => ({ ...line, eventId: id, previousLineNo: line.lineNo })));
  if (links.length)
    await tx.insert(documents).values(links.map((link) => ({ ...link, eventId: id })));
  await tx
    .update(roots)
    .set({
      pendingDraftId: id,
      nextRevision: root.nextRevision + 1,
      lifecycleVersion: root.lifecycleVersion + 1,
    })
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, root.id)));
  return id;
}

async function voidRevision(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  root: ReceivingRootRow,
  before: ReceivingLiveRecord,
  reason: string,
) {
  const lotIds =
    before.content.kind === "finalized"
      ? [...new Set(before.content.snapshot.items.map((line) => line.lotId))].sort()
      : [];
  for (const id of lotIds) {
    const lots = schema.traceabilityLots;
    const [lot] = await tx
      .select({ id: lots.id })
      .from(lots)
      .where(and(eq(lots.tenantId, tenantId), eq(lots.id, id)))
      .for("update");
    if (!lot) throw unavailable();
  }
  // Complete Receiving-only integrity is checked after all lot locks. Unknown
  // kinds cannot stand in for unimplemented downstream dependency writers.
  for (const id of lotIds) await readReceivingBasis(tx, tenantId, id, { limit: 1, offset: 0 });
  await tx
    .update(events)
    .set({ status: "void", voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason })
    .where(and(eq(events.tenantId, tenantId), eq(events.id, before.id)));
  await tx
    .update(roots)
    .set({
      currentEventId: before.status === "finalized" ? null : root.currentEventId,
      pendingDraftId: before.status === "draft" ? null : root.pendingDraftId,
      lifecycleVersion: root.lifecycleVersion + 1,
    })
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, root.id)));
  await bumpReceivingBasisVersions(tx, tenantId, lotIds);
  return before.id;
}

/** Internal command foundation. HTTP and the current response-format switch remain separate. */
export function executeReceivingLifecycle(
  db: Db,
  tenantId: string,
  actorUserId: string,
  command: "receiving.amend" | "receiving.void",
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return receivingTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const value =
      command === "receiving.amend"
        ? parseMasterDataInput(amendReceivingSchema, input)
        : parseMasterDataInput(voidReceivingSchema, input);
    const inputDigest = receivingLifecycleCommandDigest(command, eventId, value);
    const stored = await lockReceivingOperation(tx, tenantId, command, value.operationKey);
    if (stored)
      return replayReceivingLifecycle(stored, command, eventId, value.operationKey, inputDigest);
    const root = await lockReceivingRoot(tx, tenantId, eventId);
    await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
      .for("update");
    const before = await readReceivingLiveRecord(tx, tenantId, eventId);
    const kinds = await tx.execute<{ invalid: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM traceability_events WHERE tenant_id=${tenantId} AND type<>'receiving'
    ) AS invalid`);
    if (kinds.rows[0]?.invalid !== false) throw unavailable();
    if (root.lifecycleVersion !== value.expectedLifecycleVersion) throw conflict(before);
    const decision = assessReceivingTransition(
      {
        id: before.id,
        status: before.status,
        revision: before.revision,
        rootId: root.id,
        currentEventId: root.currentEventId,
        pendingDraftId: root.pendingDraftId,
        supersededByEventId: before.lifecycle.supersededByEventId,
        lifecycleVersion: root.lifecycleVersion,
        nextRevision: root.nextRevision,
      },
      command === "receiving.amend" ? "amend" : "void",
    );
    if (!decision.ok) {
      if (decision.code === "receiving_pending_amendment")
        throw new ConflictException({
          code: decision.code,
          pendingDraftId: decision.pendingDraftId,
        });
      throw conflict(before);
    }
    if (
      "expectedDraftVersion" in value &&
      value.expectedDraftVersion !== (before.status === "draft" ? before.draftVersion : null)
    )
      throw new ConflictException({ code: "receiving_draft_conflict" });
    const resultId =
      command === "receiving.amend"
        ? await startAmendment(tx, tenantId, actorUserId, root, before, value.reason)
        : await voidRevision(tx, tenantId, actorUserId, root, before, value.reason);
    const after = await readReceivingLiveRecord(tx, tenantId, resultId);
    const parsed = receivingOperationReceiptV2Schema.safeParse({
      receiptVersion: 2,
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
        command === "receiving.amend"
          ? "traceability.receiving.amendment_started"
          : "traceability.receiving.voided",
      outcome: "success",
      targetType: "traceability_event",
      targetId: resultId,
      before,
      after: {
        rootId: root.id,
        revision: after.revision,
        reason: value.reason,
        result: command === "receiving.amend" ? "draft_started" : "voided",
        record: after,
      },
      requestId,
    });
    await tx.insert(schema.receivingOperations).values({
      tenantId,
      command,
      operationKey: value.operationKey,
      inputDigest,
      eventId: resultId,
      result: parsed.data,
    });
    return parsed.data;
  });
}
