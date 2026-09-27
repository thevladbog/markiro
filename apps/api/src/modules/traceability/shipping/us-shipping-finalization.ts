import { schema, type Db } from "@markiro/db";
import {
  buildLocationDescriptionSnapshot,
  buildProductSnapshot,
  US_CAPABILITY,
  type LocationDescriptionSnapshot,
} from "@markiro/domain";
import {
  finalizeShippingSchema,
  platformUuidSchema,
  shippingFinalizationSnapshotV1Schema,
  shippingFinalizedRecordSchema,
  shippingHistoricalRecordSchema,
  type ShippingFinalizedRecord,
  type ShippingHistoricalRecord,
} from "@markiro/platform-contracts";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  authorizeUsMasterData,
  locationResponse,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { bumpLotDependencyVersions } from "../lots/us-current-consumers";
import { profileDefaults } from "../products/us-product-profile-support";
import {
  lockShippingOperation,
  readShippingDraft,
  shippingCommandDigest,
  shippingTransaction,
} from "./us-shipping-draft";
import { readCurrentShippingBalance } from "./us-shipping-balance";
import { readShippingFinalizationContext } from "./us-shipping-readiness";
import {
  applyShippingStatusEffect,
  compensateShippingStatusEffect,
  transferShippingStatusEffect,
} from "./us-shipping-status-effects";

const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });

function locationDescription(row: typeof schema.traceabilityLocations.$inferSelect) {
  const built = buildLocationDescriptionSnapshot(locationResponse(row));
  if (!built.ok) throw unavailable();
  return built.snapshot;
}

/** 0134's applied child guard still requires flat keys; typed evidence is authoritative. */
function recipientChildSnapshot(location: LocationDescriptionSnapshot) {
  const address =
    location.address.kind === "street"
      ? location.address.streetAddress
      : `${location.address.latitude}, ${location.address.longitude}`;
  return {
    id: location.locationId,
    description: [
      location.businessName,
      address,
      location.city,
      location.stateOrRegion,
      location.zipOrPostalCode,
      location.countryDisplay,
      location.phoneNumber,
    ].join(", "),
    location,
  };
}

function freezeSnapshot(
  saved: Awaited<ReturnType<typeof readShippingDraft>>,
  facts: Awaited<ReturnType<typeof readShippingFinalizationContext>>,
  actorUserId: string,
  finalizedAt: string,
) {
  const location = (id: string | null) => {
    const row = facts.locationRows.find((entry) => entry.id === id);
    if (!row) throw unavailable();
    return locationDescription(row);
  };
  const snapshot = {
    snapshotVersion: 1,
    eventId: saved.id,
    eventNumber: saved.eventNumber,
    revision: saved.revision,
    ...(saved.lifecycle?.previousRevisionId
      ? { previousRevisionId: saved.lifecycle.previousRevisionId }
      : {}),
    eventDate: saved.draft.eventDate,
    timeZone: saved.timeZone,
    shipFrom: location(saved.draft.shipFromLocationId),
    recipient: location(saved.draft.recipientLocationId),
    carrierReference: saved.draft.carrierReference,
    notes: saved.draft.notes,
    items: saved.draft.items.map((line, index) => {
      const lot = facts.lotRows.find((entry) => entry.id === line.lotId);
      if (!lot) throw unavailable();
      const productRow = facts.productRows.find((entry) => entry.product.id === lot.productId);
      const productFact = facts.input.products.find((entry) => entry.id === lot.productId);
      if (!productRow || !productFact) throw unavailable();
      const built = buildProductSnapshot(
        productRow.product,
        productRow.profile ?? profileDefaults(productRow.product),
      );
      if (!built.ok) throw unavailable();
      const source =
        lot.sourceLocationId !== null
          ? { kind: "location" as const, location: location(lot.sourceLocationId) }
          : {
              kind: "reference" as const,
              referenceKind: lot.sourceReferenceKind,
              referenceValue: lot.sourceReferenceValue,
              resolvedLocation: location(lot.sourceReferenceLocationId),
            };
      return {
        lineNo: index + 1,
        lotId: lot.id,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        tlc: lot.tlc,
        source,
        product: { id: lot.productId, description: built.snapshot, coverage: productFact.coverage },
      };
    }),
    documents: saved.draft.documentIds.map((id) => {
      const row = facts.documentRows.find((entry) => entry.id === id);
      if (!row) throw unavailable();
      const party = facts.partyRows.find((entry) => entry.id === row.partyId);
      return {
        id,
        type: row.type === "other" ? row.typeOtherLabel : row.type,
        number: row.number,
        issuer: party ? { id: party.id, name: party.name, legalName: party.legalName } : null,
      };
    }),
    finalizedBy: actorUserId,
    finalizedAt,
  };
  const parsed = shippingFinalizationSnapshotV1Schema.safeParse(snapshot);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

/** Historical reads never consult mutable master data. */
export async function readShippingSnapshotRecord(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<ShippingHistoricalRecord> {
  const events = schema.traceabilityEvents;
  const [event] = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")));
  if (!event) throw new NotFoundException({ code: "shipping_not_found" });
  if (event.status !== "finalized" && event.status !== "amended" && event.status !== "void")
    throw new ConflictException({ code: "shipping_not_draft" });
  const [root] = await tx
    .select()
    .from(schema.shippingEventRoots)
    .where(
      and(
        eq(schema.shippingEventRoots.tenantId, tenantId),
        eq(schema.shippingEventRoots.id, event.rootEventId),
      ),
    );
  const snapshot = shippingFinalizationSnapshotV1Schema.safeParse(event.finalizationSnapshot);
  if (!root || !snapshot.success) throw unavailable();
  const data = snapshot.data;
  const parsed = shippingHistoricalRecordSchema.safeParse({
    id: event.id,
    eventNumber: event.eventNumber,
    revision: event.revision,
    draftVersion: event.draftVersion,
    timeZone: event.timeZone,
    createdBy: event.createdBy,
    updatedBy: event.updatedBy,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    status: event.status,
    snapshot: data,
    draft: {
      eventDate: data.eventDate,
      shipFromLocationId: data.shipFrom.locationId,
      recipientLocationId: data.recipient.locationId,
      carrierReference: data.carrierReference,
      notes: data.notes,
      items: data.items.map((line) => ({
        lotId: line.lotId,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
      })),
      documentIds: data.documents.map((row) => row.id),
    },
    lifecycle: {
      rootId: root.id,
      lifecycleVersion: root.lifecycleVersion,
      currentEventId: root.currentEventId,
      pendingDraftId: root.pendingDraftId,
      previousRevisionId: event.previousRevisionId,
      amendmentReason: event.amendmentReason,
      supersededByEventId: event.supersededByEventId,
      supersededAt: event.supersededAt?.toISOString() ?? null,
      supersededBy: event.supersededBy,
      voidedAt: event.voidedAt?.toISOString() ?? null,
      voidedBy: event.voidedBy,
      voidReason: event.voidReason,
    },
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export async function readShippingFinalizedRecord(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<ShippingFinalizedRecord> {
  const record = await readShippingSnapshotRecord(tx, tenantId, eventId);
  if (record.status !== "finalized") throw new ConflictException({ code: "shipping_not_draft" });
  return record;
}

export function finalizeShipping(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
): Promise<ShippingFinalizedRecord> {
  return shippingTransaction(db, async (tx) => {
    const profileCode = await authorizeUsMasterData(
      tx,
      tenantId,
      actorUserId,
      US_CAPABILITY.QA_MANAGE,
    );
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const value = parseMasterDataInput(finalizeShippingSchema, input);
    const command = "shipping.finalize";
    const inputDigest = shippingCommandDigest(command, value, eventId);
    const receipt = await lockShippingOperation(tx, tenantId, command, value.operationKey);
    if (receipt) {
      if (receipt.inputDigest !== inputDigest)
        throw new ConflictException({ code: "shipping_operation_conflict" });
      const replay = shippingFinalizedRecordSchema.safeParse(receipt.result);
      if (!replay.success || replay.data.id !== eventId || receipt.eventId !== eventId)
        throw unavailable();
      return replay.data;
    }
    const before = await readShippingDraft(tx, tenantId, eventId, "update");
    if (before.draftVersion !== value.expectedDraftVersion)
      throw new ConflictException({ code: "shipping_draft_conflict" });
    const predecessorId = before.lifecycle?.previousRevisionId ?? null;
    if (
      before.revision > 1 &&
      (!predecessorId ||
        before.lifecycle?.currentEventId !== predecessorId ||
        before.lifecycle?.pendingDraftId !== eventId)
    )
      throw new ConflictException({ code: "shipping_lifecycle_conflict" });
    const predecessor = predecessorId
      ? await readShippingSnapshotRecord(tx, tenantId, predecessorId)
      : null;
    if (predecessor && predecessor.status !== "finalized")
      throw new ConflictException({ code: "shipping_lifecycle_conflict" });
    const newLotIds = before.draft.items
      .map((line) => line.lotId)
      .filter((id): id is string => id !== null);
    const oldLotIds =
      predecessor?.status === "finalized"
        ? predecessor.snapshot.items.map((line) => line.lotId)
        : [];
    const lotIds = [...new Set([...oldLotIds, ...newLotIds])].sort();
    if (lotIds.length) {
      const locked = await tx
        .select({ id: schema.traceabilityLots.id })
        .from(schema.traceabilityLots)
        .where(
          and(
            eq(schema.traceabilityLots.tenantId, tenantId),
            inArray(schema.traceabilityLots.id, lotIds),
          ),
        )
        .orderBy(asc(schema.traceabilityLots.id))
        .for("update");
      if (locked.length !== lotIds.length) throw unavailable();
    }
    const facts = await readShippingFinalizationContext(tx, tenantId, before, profileCode);
    if (facts.readiness.state !== "complete")
      throw new ConflictException({ code: "event_incomplete", issues: facts.readiness.issues });
    if (facts.readiness.inputDigest !== value.expectedInputDigest)
      throw new ConflictException({ code: "shipping_readiness_changed" });
    await bumpLotDependencyVersions(tx, tenantId, lotIds);
    const now = new Date();
    const snapshot = freezeSnapshot(before, facts, actorUserId, now.toISOString());
    await tx
      .update(schema.shippingEventDetails)
      .set({ recipientSnapshot: recipientChildSnapshot(snapshot.recipient) })
      .where(
        and(
          eq(schema.shippingEventDetails.tenantId, tenantId),
          eq(schema.shippingEventDetails.eventId, eventId),
        ),
      );
    for (const line of snapshot.items)
      await tx
        .update(schema.shippingEventItems)
        .set({
          tlcSnapshot: line.tlc,
          sourceSnapshot: line.source,
          productSnapshot: line.product,
        })
        .where(
          and(
            eq(schema.shippingEventItems.tenantId, tenantId),
            eq(schema.shippingEventItems.eventId, eventId),
            eq(schema.shippingEventItems.lineNo, line.lineNo),
          ),
        );
    if (predecessorId)
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "amended",
          supersededByEventId: eventId,
          supersededAt: now,
          supersededBy: actorUserId,
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, tenantId),
            eq(schema.traceabilityEvents.id, predecessorId),
            eq(schema.traceabilityEvents.type, "shipping"),
            eq(schema.traceabilityEvents.status, "finalized"),
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
          eq(schema.traceabilityEvents.type, "shipping"),
        ),
      );
    await tx
      .update(schema.shippingEventRoots)
      .set({
        currentEventId: eventId,
        pendingDraftId: null,
        lifecycleVersion: (before.lifecycle?.lifecycleVersion ?? 1) + 1,
      })
      .where(
        and(
          eq(schema.shippingEventRoots.tenantId, tenantId),
          eq(schema.shippingEventRoots.id, before.lifecycle?.rootId ?? eventId),
        ),
      );
    const statusEffects: string[] = [];
    for (const lotId of lotIds) {
      const balance = await readCurrentShippingBalance(tx, tenantId, lotId);
      const prior = await tx
        .select({ status: schema.traceabilityLots.status })
        .from(schema.traceabilityLots)
        .where(
          and(
            eq(schema.traceabilityLots.tenantId, tenantId),
            eq(schema.traceabilityLots.id, lotId),
          ),
        );
      const context = {
        actorUserId,
        requestId,
        reason: `Shipping ${before.eventNumber} finalized`,
      };
      await compensateShippingStatusEffect(tx, tenantId, lotId, eventId, balance, context);
      if (predecessorId)
        await transferShippingStatusEffect(
          tx,
          tenantId,
          lotId,
          predecessorId,
          eventId,
          balance,
          context,
        );
      await applyShippingStatusEffect(tx, tenantId, lotId, eventId, balance, context);
      if (prior[0]?.status === "active" && balance.state === "known" && balance.remaining === "0")
        statusEffects.push(lotId);
    }
    const result = await readShippingFinalizedRecord(tx, tenantId, eventId);
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "traceability.shipping.finalized",
      outcome: "success",
      targetType: "traceability_event",
      targetId: eventId,
      before,
      after: { ...result, lotIds, statusEffects },
      requestId,
    });
    await tx.insert(schema.shippingOperations).values({
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
