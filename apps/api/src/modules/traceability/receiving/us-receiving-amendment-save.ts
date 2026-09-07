import { isDeepStrictEqual } from "node:util";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { ConflictException } from "@nestjs/common";
import {
  platformUuidSchema,
  receivingOperationReceiptV2Schema,
  saveReceivingAmendmentSchema,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import {
  lockReceivingOperation,
  receivingLifecycleCommandDigest,
  receivingTransaction,
  replayReceivingLifecycle,
} from "./us-receiving-operations";
import { lockReceivingRoot } from "./us-receiving-roots";
import { readReceivingLiveRecord } from "./us-receiving-history";
import { receivingHeader, replaceReceivingChildren, unavailable } from "./us-receiving-persistence";
import { validateReceivingAmendment } from "./us-receiving-amendment";
import { assertReceivingAmendmentReferences } from "./us-receiving-amendment-references";

/** Additive internal command; no legacy digest/receipt or HTTP response is switched here. */
export function saveReceivingAmendment(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return receivingTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const value = parseMasterDataInput(saveReceivingAmendmentSchema, input);
    const command = "receiving.save";
    const inputDigest = receivingLifecycleCommandDigest(command, eventId, value);
    const stored = await lockReceivingOperation(tx, tenantId, command, value.operationKey);
    if (stored)
      return replayReceivingLifecycle(stored, command, eventId, value.operationKey, inputDigest);
    const root = await lockReceivingRoot(tx, tenantId, eventId);
    const events = schema.traceabilityEvents;
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
    if (
      root.lifecycleVersion !== value.expectedLifecycleVersion ||
      before.status !== "draft" ||
      before.revision === 1 ||
      before.content.kind !== "draft" ||
      root.pendingDraftId !== eventId ||
      before.lifecycle.previousRevisionId !== root.currentEventId
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
    const { retainedBindings } = await validateReceivingAmendment(
      tx,
      tenantId,
      before,
      value.draft,
    );
    const draft = {
      ...value.draft,
      items: value.draft.items.map((line) => ({
        ...line,
        exemptReceipt: line.exemptReceipt ?? null,
      })),
    };
    const changed = !isDeepStrictEqual(before.content.draft, draft);
    if (changed) {
      if (before.draftVersion >= 2_147_483_647) throw unavailable();
      await assertReceivingAmendmentReferences(tx, tenantId, draft, retainedBindings);
      await tx
        .update(events)
        .set({
          ...receivingHeader(draft),
          draftVersion: before.draftVersion + 1,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)));
      await replaceReceivingChildren(tx, tenantId, eventId, draft);
    }
    const after = changed ? await readReceivingLiveRecord(tx, tenantId, eventId) : before;
    const parsed = receivingOperationReceiptV2Schema.safeParse({
      receiptVersion: 2,
      command,
      operationKey: value.operationKey,
      inputDigest,
      eventId,
      record: after,
    });
    if (!parsed.success) throw unavailable();
    if (changed)
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.receiving.draft_saved",
        outcome: "success",
        targetType: "traceability_event",
        targetId: eventId,
        before,
        after,
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
}
