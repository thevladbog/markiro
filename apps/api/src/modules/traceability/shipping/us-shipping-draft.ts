import { createHash, randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  createShippingDraftSchema,
  platformUuidSchema,
  saveShippingDraftSchema,
  shippingDraftRecordSchema,
  shippingDraftSchema,
  shippingReadinessQuerySchema,
  shippingBalanceQuerySchema,
  shippingBalanceResponseSchema,
  shippingRevisionListQuerySchema,
  type ShippingDraft,
  type ShippingDraftRecord,
} from "@markiro/platform-contracts";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readShippingReadiness } from "./us-shipping-readiness";
import { finalizeShipping } from "./us-shipping-finalization";
import { readShippingRecord, readShippingRevisions } from "./us-shipping-history";
import { executeShippingLifecycle } from "./us-shipping-lifecycle";
import { readCurrentShippingBalanceProjection } from "./us-shipping-balance";

const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });
const notFound = () => new NotFoundException({ code: "shipping_not_found" });
const referenceNotFound = () => new NotFoundException({ code: "shipping_reference_not_found" });
const ids = (values: readonly (string | null)[]) =>
  [...new Set(values.filter((value): value is string => value !== null))].sort();

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error.code === "40001" || error.code === "40P01")) return true;
  if (
    "code" in error &&
    error.code === "23505" &&
    "table" in error &&
    error.table === "shipping_operations" &&
    "constraint" in error &&
    error.constraint === "shipping_operations_tenant_id_command_operation_key_pk"
  )
    return true;
  return "cause" in error && retryable(error.cause);
}

export async function shippingTransaction<T>(
  db: Db,
  run: (tx: UsMasterDataTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(run, { isolationLevel: "repeatable read" });
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === 2) throw unavailable();
    }
  }
  throw unavailable();
}

export function shippingCommandDigest(
  command:
    "shipping.create" | "shipping.save" | "shipping.finalize" | "shipping.amend" | "shipping.void",
  input: unknown,
  eventId?: string,
) {
  return createHash("sha256")
    .update(JSON.stringify({ commandVersion: 1, command, ...(eventId ? { eventId } : {}), input }))
    .digest("hex");
}

export async function lockShippingOperation(
  tx: UsMasterDataTransaction,
  tenantId: string,
  command:
    "shipping.create" | "shipping.save" | "shipping.finalize" | "shipping.amend" | "shipping.void",
  operationKey: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["us-shipping", tenantId, command, operationKey])},0))`,
  );
  const table = schema.shippingOperations;
  const [stored] = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.tenantId, tenantId),
        eq(table.command, command),
        eq(table.operationKey, operationKey),
      ),
    );
  return stored;
}

function replay(
  stored: typeof schema.shippingOperations.$inferSelect,
  inputDigest: string,
  eventId?: string,
) {
  if (stored.inputDigest !== inputDigest)
    throw new ConflictException({ code: "shipping_operation_conflict" });
  const result = shippingDraftRecordSchema.safeParse(stored.result);
  if (
    !result.success ||
    result.data.id !== stored.eventId ||
    (eventId && result.data.id !== eventId)
  )
    throw unavailable();
  return result.data;
}

/** Draft references are tenant-owned. Archival is a live readiness finding. */
async function assertReferences(
  tx: UsMasterDataTransaction,
  tenantId: string,
  draft: ShippingDraft,
) {
  const lotIds = ids(draft.items.map((line) => line.lotId));
  const locationIds = ids([draft.shipFromLocationId, draft.recipientLocationId]);
  const documentIds = ids(draft.documentIds);
  if (lotIds.length) {
    const rows = await tx
      .select({ id: schema.traceabilityLots.id })
      .from(schema.traceabilityLots)
      .where(
        and(
          eq(schema.traceabilityLots.tenantId, tenantId),
          inArray(schema.traceabilityLots.id, lotIds),
        ),
      )
      .orderBy(asc(schema.traceabilityLots.id))
      .for("share");
    if (rows.length !== lotIds.length) throw referenceNotFound();
  }
  if (locationIds.length) {
    const rows = await tx
      .select({ id: schema.traceabilityLocations.id })
      .from(schema.traceabilityLocations)
      .where(
        and(
          eq(schema.traceabilityLocations.tenantId, tenantId),
          inArray(schema.traceabilityLocations.id, locationIds),
        ),
      )
      .orderBy(asc(schema.traceabilityLocations.id))
      .for("share");
    if (rows.length !== locationIds.length) throw referenceNotFound();
  }
  if (documentIds.length) {
    const rows = await tx
      .select({ id: schema.referenceDocuments.id })
      .from(schema.referenceDocuments)
      .where(
        and(
          eq(schema.referenceDocuments.tenantId, tenantId),
          inArray(schema.referenceDocuments.id, documentIds),
        ),
      )
      .orderBy(asc(schema.referenceDocuments.id))
      .for("share");
    if (rows.length !== documentIds.length) throw referenceNotFound();
  }
}

export async function replaceShippingChildren(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  draft: ShippingDraft,
) {
  const details = schema.shippingEventDetails,
    items = schema.shippingEventItems,
    documents = schema.shippingEventDocuments;
  await tx
    .delete(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.eventId, eventId)));
  await tx.delete(items).where(and(eq(items.tenantId, tenantId), eq(items.eventId, eventId)));
  await tx.delete(details).where(and(eq(details.tenantId, tenantId), eq(details.eventId, eventId)));
  await tx.insert(details).values({
    tenantId,
    eventId,
    recipientLocationId: draft.recipientLocationId,
    carrierReference: draft.carrierReference,
  });
  if (draft.items.length)
    await tx
      .insert(items)
      .values(draft.items.map((line, i) => ({ tenantId, eventId, lineNo: i + 1, ...line })));
  if (draft.documentIds.length)
    await tx.insert(documents).values(
      draft.documentIds.map((documentId, i) => ({
        tenantId,
        eventId,
        documentId,
        position: i + 1,
      })),
    );
}

export async function readShippingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  lock: "share" | "update" = "share",
): Promise<ShippingDraftRecord> {
  const events = schema.traceabilityEvents,
    roots = schema.shippingEventRoots;
  const [identity] = await tx
    .select({ rootEventId: events.rootEventId })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")));
  if (!identity) throw notFound();
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, identity.rootEventId)))
    .for(lock);
  const [row] = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")))
    .for(lock);
  if (
    !root ||
    !row ||
    root.pendingDraftId !== row.id ||
    row.status !== "draft" ||
    row.finalizationSnapshot !== null ||
    row.eventNumber !== root.eventNumber
  ) {
    if (row && row.status !== "draft") throw new ConflictException({ code: "shipping_not_draft" });
    throw unavailable();
  }
  const [detail] = await tx
    .select()
    .from(schema.shippingEventDetails)
    .where(
      and(
        eq(schema.shippingEventDetails.tenantId, tenantId),
        eq(schema.shippingEventDetails.eventId, eventId),
      ),
    );
  if (!detail || detail.recipientSnapshot !== null) throw unavailable();
  const itemRows = await tx
    .select()
    .from(schema.shippingEventItems)
    .where(
      and(
        eq(schema.shippingEventItems.tenantId, tenantId),
        eq(schema.shippingEventItems.eventId, eventId),
      ),
    )
    .orderBy(asc(schema.shippingEventItems.lineNo));
  const documentRows = await tx
    .select()
    .from(schema.shippingEventDocuments)
    .where(
      and(
        eq(schema.shippingEventDocuments.tenantId, tenantId),
        eq(schema.shippingEventDocuments.eventId, eventId),
      ),
    )
    .orderBy(asc(schema.shippingEventDocuments.position));
  if (
    itemRows.some(
      (line, index) =>
        line.lineNo !== index + 1 ||
        line.tlcSnapshot !== null ||
        line.sourceSnapshot !== null ||
        line.productSnapshot !== null,
    ) ||
    documentRows.some((line, index) => line.position !== index + 1)
  )
    throw unavailable();
  const parsedDraft = shippingDraftSchema.safeParse({
    eventDate: row.dateReceived,
    shipFromLocationId: row.locationId,
    recipientLocationId: detail.recipientLocationId,
    carrierReference: detail.carrierReference,
    notes: row.notes,
    items: itemRows.map((line) => ({
      lotId: line.lotId,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
    documentIds: documentRows.map((line) => line.documentId),
  });
  if (!parsedDraft.success) throw unavailable();
  const parsed = shippingDraftRecordSchema.safeParse({
    id: row.id,
    eventNumber: row.eventNumber,
    revision: row.revision,
    draftVersion: row.draftVersion,
    timeZone: row.timeZone,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    status: row.status,
    draft: parsedDraft.data,
    lifecycle: {
      rootId: root.id,
      lifecycleVersion: root.lifecycleVersion,
      currentEventId: root.currentEventId,
      pendingDraftId: root.pendingDraftId,
      previousRevisionId: row.previousRevisionId,
      amendmentReason: row.amendmentReason,
    },
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export class UsShippingStore {
  constructor(private readonly db: Db) {}

  createDraft(tenantId: string, actorUserId: string, input: unknown, requestId: string) {
    return shippingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.SHIPPING_WRITE);
      const value = parseMasterDataInput(createShippingDraftSchema, input);
      const command = "shipping.create",
        inputDigest = shippingCommandDigest(command, value);
      const stored = await lockShippingOperation(tx, tenantId, command, value.operationKey);
      if (stored) return replay(stored, inputDigest);
      await assertReferences(tx, tenantId, value.draft);
      const [profile] = await tx
        .select({ timeZone: schema.orgProfiles.timeZone })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, tenantId));
      if (!profile) throw unavailable();
      const now = new Date();
      const year = Number(
        new Intl.DateTimeFormat("en-US", { timeZone: profile.timeZone, year: "numeric" }).format(
          now,
        ),
      );
      const counters = schema.shippingCounters;
      const [counter] = await tx
        .insert(counters)
        .values({ tenantId, year, sequence: 1 })
        .onConflictDoUpdate({
          target: [counters.tenantId, counters.year],
          set: { sequence: sql`${counters.sequence} + 1` },
        })
        .returning();
      if (!counter || counter.sequence > 9999999999) throw unavailable();
      const eventId = randomUUID();
      const eventNumber = `SHP-${String(year).slice(-2).padStart(2, "0")}-${String(counter.sequence).padStart(4, "0")}`;
      await tx
        .insert(schema.shippingEventRoots)
        .values({ tenantId, id: eventId, eventNumber, pendingDraftId: eventId });
      await tx.insert(schema.traceabilityEvents).values({
        id: eventId,
        rootEventId: eventId,
        tenantId,
        eventNumber,
        type: "shipping",
        timeZone: profile.timeZone,
        dateReceived: value.draft.eventDate,
        locationId: value.draft.shipFromLocationId,
        notes: value.draft.notes,
        createdBy: actorUserId,
        updatedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceShippingChildren(tx, tenantId, eventId, value.draft);
      const result = await readShippingDraft(tx, tenantId, eventId, "update");
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.shipping.draft_created",
        outcome: "success",
        targetType: "traceability_event",
        targetId: eventId,
        before: null,
        after: result,
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

  saveDraft(
    tenantId: string,
    actorUserId: string,
    eventIdInput: unknown,
    input: unknown,
    requestId: string,
  ) {
    return shippingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.SHIPPING_WRITE);
      const eventId = parseMasterDataInput(platformUuidSchema, eventIdInput);
      const value = parseMasterDataInput(saveShippingDraftSchema, input);
      const [identity] = await tx
        .select({ revision: schema.traceabilityEvents.revision })
        .from(schema.traceabilityEvents)
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, tenantId),
            eq(schema.traceabilityEvents.id, eventId),
            eq(schema.traceabilityEvents.type, "shipping"),
          ),
        );
      if (!identity) throw notFound();
      if (identity.revision > 1)
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);
      const command = "shipping.save",
        inputDigest = shippingCommandDigest(command, value, eventId);
      const stored = await lockShippingOperation(tx, tenantId, command, value.operationKey);
      if (stored) return replay(stored, inputDigest, eventId);
      const before = await readShippingDraft(tx, tenantId, eventId, "update");
      if (before.draftVersion !== value.expectedDraftVersion || before.draftVersion === 2147483647)
        throw new ConflictException({ code: "shipping_draft_conflict" });
      await assertReferences(tx, tenantId, value.draft);
      const events = schema.traceabilityEvents;
      await tx
        .update(events)
        .set({
          dateReceived: value.draft.eventDate,
          locationId: value.draft.shipFromLocationId,
          notes: value.draft.notes,
          draftVersion: before.draftVersion + 1,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .where(
          and(eq(events.tenantId, tenantId), eq(events.id, eventId), eq(events.type, "shipping")),
        );
      await replaceShippingChildren(tx, tenantId, eventId, value.draft);
      const result = await readShippingDraft(tx, tenantId, eventId, "update");
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.shipping.draft_saved",
        outcome: "success",
        targetType: "traceability_event",
        targetId: eventId,
        before,
        after: result,
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

  getRecord(tenantId: string, actorUserId: string, eventIdInput: unknown) {
    return shippingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const eventId = parseMasterDataInput(platformUuidSchema, eventIdInput);
      return readShippingRecord(tx, tenantId, eventId);
    });
  }

  getLotShippingBalance(
    tenantId: string,
    actorUserId: string,
    lotIdInput: unknown,
    queryInput: unknown,
  ) {
    return shippingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const lotId = parseMasterDataInput(platformUuidSchema, lotIdInput);
      const query = parseMasterDataInput(shippingBalanceQuerySchema, queryInput);
      let excludedEventId: string | undefined;
      if ("contextDraftId" in query) {
        const saved = await readShippingDraft(tx, tenantId, query.contextDraftId);
        if (saved.draftVersion !== query.expectedDraftVersion)
          throw new ConflictException({ code: "shipping_draft_conflict" });
        const predecessorId = saved.lifecycle?.previousRevisionId;
        if (saved.revision > 1) {
          if (!predecessorId || saved.lifecycle?.currentEventId !== predecessorId)
            throw unavailable();
          excludedEventId = predecessorId;
        } else if (saved.lifecycle?.currentEventId !== null) throw unavailable();
      }
      const lots = schema.traceabilityLots;
      const [lot] = await tx
        .select({ id: lots.id })
        .from(lots)
        .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
        .for("update");
      if (!lot) throw new NotFoundException({ code: "shipping_lot_not_found" });
      return shippingBalanceResponseSchema.parse({
        lotId,
        ...(await readCurrentShippingBalanceProjection(tx, tenantId, lotId, excludedEventId)),
      });
    });
  }

  checkReadiness(
    tenantId: string,
    actorUserId: string,
    eventIdInput: unknown,
    queryInput: unknown,
  ) {
    return shippingTransaction(this.db, async (tx) => {
      const profileCode = await authorizeUsMasterData(
        tx,
        tenantId,
        actorUserId,
        US_CAPABILITY.READ,
      );
      const eventId = parseMasterDataInput(platformUuidSchema, eventIdInput);
      const query = parseMasterDataInput(shippingReadinessQuerySchema, queryInput);
      const saved = await readShippingDraft(tx, tenantId, eventId);
      if (saved.draftVersion !== query.expectedDraftVersion)
        throw new ConflictException({ code: "shipping_draft_conflict" });
      return readShippingReadiness(tx, tenantId, saved, profileCode);
    });
  }

  finalize(
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    input: unknown,
    requestId: string,
  ) {
    return finalizeShipping(this.db, tenantId, actorUserId, eventId, input, requestId);
  }

  amend(
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    input: unknown,
    requestId: string,
  ) {
    return executeShippingLifecycle(
      this.db,
      tenantId,
      actorUserId,
      "shipping.amend",
      eventId,
      input,
      requestId,
    );
  }

  void(tenantId: string, actorUserId: string, eventId: unknown, input: unknown, requestId: string) {
    return executeShippingLifecycle(
      this.db,
      tenantId,
      actorUserId,
      "shipping.void",
      eventId,
      input,
      requestId,
    );
  }

  listRevisions(tenantId: string, actorUserId: string, eventIdInput: unknown, queryInput: unknown) {
    return shippingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const eventId = parseMasterDataInput(platformUuidSchema, eventIdInput);
      const query = parseMasterDataInput(shippingRevisionListQuerySchema, queryInput);
      return readShippingRevisions(tx, tenantId, eventId, query);
    });
  }
}
