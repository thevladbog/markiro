import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  amendShippingSchema,
  platformUuidSchema,
  shippingLifecycleReceiptSchema,
  voidShippingSchema,
} from "@markiro/platform-contracts";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { bumpLotDependencyVersions } from "../lots/us-current-consumers";
import { readCurrentShippingBalance } from "./us-shipping-balance";
import {
  lockShippingOperation,
  replaceShippingChildren,
  shippingCommandDigest,
  shippingTransaction,
} from "./us-shipping-draft";
import { readShippingRecord } from "./us-shipping-history";
import { compensateShippingStatusEffect } from "./us-shipping-status-effects";

const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });
const events = schema.traceabilityEvents;
const roots = schema.shippingEventRoots;

/** Root first, then every affected lot in deterministic UUID order. */
async function lockLots(tx: UsMasterDataTransaction, tenantId: string, lotIds: readonly string[]) {
  const ids = [...new Set(lotIds)].sort();
  if (!ids.length) return ids;
  const rows = await tx
    .select({ id: schema.traceabilityLots.id })
    .from(schema.traceabilityLots)
    .where(
      and(eq(schema.traceabilityLots.tenantId, tenantId), inArray(schema.traceabilityLots.id, ids)),
    )
    .orderBy(asc(schema.traceabilityLots.id))
    .for("update");
  if (rows.length !== ids.length) throw unavailable();
  return ids;
}

/** Shipping is terminal in the current CTE set; no other shipment on the same lot is its downstream child. */
export function executeShippingLifecycle(
  db: Db,
  tenantId: string,
  actorUserId: string,
  command: "shipping.amend" | "shipping.void",
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return shippingTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const value =
      command === "shipping.amend"
        ? parseMasterDataInput(amendShippingSchema, input)
        : parseMasterDataInput(voidShippingSchema, input);
    const inputDigest = shippingCommandDigest(command, value, eventId);
    const stored = await lockShippingOperation(tx, tenantId, command, value.operationKey);
    if (stored) {
      if (stored.inputDigest !== inputDigest)
        throw new ConflictException({ code: "shipping_operation_conflict" });
      const parsed = shippingLifecycleReceiptSchema.safeParse(stored.result);
      if (
        !parsed.success ||
        parsed.data.eventId !== stored.eventId ||
        (command === "shipping.void"
          ? parsed.data.eventId !== eventId
          : parsed.data.record.lifecycle?.previousRevisionId !== eventId)
      )
        throw unavailable();
      return parsed.data;
    }
    const [identity] = await tx
      .select({ rootId: events.rootEventId })
      .from(events)
      .where(
        and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")),
      );
    if (!identity) throw new NotFoundException({ code: "shipping_not_found" });
    const [root] = await tx
      .select()
      .from(roots)
      .where(and(eq(roots.tenantId, tenantId), eq(roots.id, identity.rootId)))
      .for("update");
    const [header] = await tx
      .select()
      .from(events)
      .where(
        and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")),
      )
      .for("update");
    if (!root || !header || root.lifecycleVersion !== value.expectedLifecycleVersion)
      throw new ConflictException({ code: "shipping_lifecycle_conflict" });
    const before = await readShippingRecord(tx, tenantId, eventId);
    let resultId: string;
    if (command === "shipping.amend") {
      if (before.status !== "finalized" || root.currentEventId !== eventId)
        throw new ConflictException({ code: "shipping_lifecycle_conflict" });
      if (root.pendingDraftId)
        throw new ConflictException({
          code: "shipping_pending_amendment",
          pendingDraftId: root.pendingDraftId,
        });
      if (root.nextRevision >= 2147483647) throw unavailable();
      const now = new Date();
      resultId = randomUUID();
      await tx.insert(events).values({
        id: resultId,
        rootEventId: root.id,
        tenantId,
        eventNumber: root.eventNumber,
        type: "shipping",
        revision: root.nextRevision,
        previousRevisionId: eventId,
        amendmentReason: value.reason,
        timeZone: header.timeZone,
        dateReceived: before.draft.eventDate,
        locationId: before.draft.shipFromLocationId,
        notes: before.draft.notes,
        createdBy: actorUserId,
        updatedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceShippingChildren(tx, tenantId, resultId, before.draft);
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
          root.pendingDraftId !== eventId ||
          (before.revision === 1 && root.currentEventId !== null)
        )
          throw new ConflictException({ code: "shipping_lifecycle_conflict" });
        if (
          !("expectedDraftVersion" in value) ||
          value.expectedDraftVersion !== before.draftVersion
        )
          throw new ConflictException({ code: "shipping_draft_conflict" });
      } else if (before.status === "finalized" && root.currentEventId === eventId) {
        if (root.pendingDraftId)
          throw new ConflictException({
            code: "shipping_pending_amendment",
            pendingDraftId: root.pendingDraftId,
          });
        if ("expectedDraftVersion" in value)
          throw new ConflictException({ code: "shipping_draft_conflict" });
        // No current event type records a downstream edge from a Shipping revision.
        // Other shipments sharing the lot are siblings, never fictitious blockers.
        const lotIds = await lockLots(
          tx,
          tenantId,
          before.snapshot.items.map((line) => line.lotId),
        );
        await bumpLotDependencyVersions(tx, tenantId, lotIds);
      } else throw new ConflictException({ code: "shipping_lifecycle_conflict" });
      resultId = eventId;
      await tx
        .update(events)
        .set({
          status: "void",
          voidedAt: new Date(),
          voidedBy: actorUserId,
          voidReason: value.reason,
        })
        .where(
          and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")),
        );
      await tx
        .update(roots)
        .set({
          ...(before.status === "draft" ? { pendingDraftId: null } : { currentEventId: null }),
          lifecycleVersion: root.lifecycleVersion + 1,
        })
        .where(and(eq(roots.tenantId, tenantId), eq(roots.id, root.id)));
      if (before.status === "finalized")
        for (const lotId of [...new Set(before.snapshot.items.map((line) => line.lotId))].sort()) {
          const balance = await readCurrentShippingBalance(tx, tenantId, lotId);
          await compensateShippingStatusEffect(tx, tenantId, lotId, eventId, balance, {
            actorUserId,
            requestId,
            reason: value.reason,
          });
        }
    }
    const after = await readShippingRecord(tx, tenantId, resultId);
    const parsed = shippingLifecycleReceiptSchema.safeParse({
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
        command === "shipping.amend"
          ? "traceability.shipping.amendment_started"
          : "traceability.shipping.voided",
      outcome: "success",
      targetType: "traceability_event",
      targetId: resultId,
      before,
      after: {
        rootId: root.id,
        revision: after.revision,
        reason: value.reason,
        result: command === "shipping.amend" ? "draft_started" : "voided",
        record: after,
      },
      requestId,
    });
    await tx.insert(schema.shippingOperations).values({
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
