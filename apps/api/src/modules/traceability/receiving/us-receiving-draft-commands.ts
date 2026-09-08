import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { ConflictException } from "@nestjs/common";
import {
  createReceivingDraftSchema,
  platformUuidSchema,
  receivingOperationReceiptV2Schema,
  saveReceivingDraftSchema,
  type ReceivingDraft,
  type ReceivingDraftRecord,
  type ReceivingLiveRecord,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";
import {
  lockReceivingOperation,
  receivingLifecycleCommandDigest,
  receivingTransaction,
} from "./us-receiving-operations";
import { assertOriginalReceivingWriteTarget } from "./us-receiving-original-command";
import {
  parseReceivingRecord,
  readReceivingDraft,
  receivingHeader,
  replaceReceivingChildren,
  unavailable,
} from "./us-receiving-persistence";
import { assertReceivingReferences } from "./us-receiving-references";
import { createReceivingRoot, lockReceivingRoot } from "./us-receiving-roots";

type Result = ReceivingDraftRecord | ReceivingOperationReceiptV2;
type Format = "legacy" | "versioned";
type Command = "receiving.create" | "receiving.save";
const events = schema.traceabilityEvents;
const counters = schema.receivingCounters;
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

// Comparison only: never normalize remembered input or its historical digest.
function comparableDraft(draft: ReceivingDraft) {
  return {
    ...draft,
    items: draft.items.map(({ exemptReceipt, ...item }) => ({
      ...item,
      exemptReceipt: exemptReceipt ?? null,
    })),
  };
}

/** The output mode is server-owned and is not accepted from a request body. */
function transaction<T>(db: Db, format: Format, run: (tx: UsMasterDataTransaction) => Promise<T>) {
  return format === "versioned" ? receivingTransaction(db, run) : db.transaction(run);
}

function replay(
  stored: typeof schema.receivingOperations.$inferSelect,
  command: Command,
  operationKey: string,
  legacyDigest: string,
  versionedDigest: string,
  format: Format,
  eventId?: string,
): Result {
  // Existing endpoints keep their strict legacy reader until the coordinated switch.
  if (format === "legacy") {
    if (stored.inputDigest !== legacyDigest)
      throw new ConflictException({ code: "receiving_operation_conflict" });
    const result = parseReceivingRecord(stored.result);
    if (result.id !== stored.eventId || (eventId !== undefined && eventId !== stored.eventId))
      throw unavailable();
    return result;
  }
  if (
    typeof stored.result === "object" &&
    stored.result !== null &&
    "receiptVersion" in stored.result
  ) {
    const parsed = receivingOperationReceiptV2Schema.safeParse(stored.result);
    if (!parsed.success) throw unavailable();
    const receipt = parsed.data;
    if (
      receipt.command !== command ||
      receipt.operationKey !== operationKey ||
      receipt.inputDigest !== stored.inputDigest ||
      receipt.eventId !== stored.eventId
    )
      throw unavailable();
    if (stored.inputDigest !== versionedDigest)
      throw new ConflictException({ code: "receiving_operation_conflict" });
    if (eventId !== undefined && eventId !== receipt.eventId) throw unavailable();
    return receipt;
  }
  const result = parseReceivingRecord(stored.result);
  if (result.id !== stored.eventId) throw unavailable();
  if (stored.inputDigest !== legacyDigest)
    throw new ConflictException({ code: "receiving_operation_conflict" });
  if (eventId !== undefined && eventId !== stored.eventId) throw unavailable();
  return result;
}

async function remember(
  tx: UsMasterDataTransaction,
  tenantId: string,
  command: Command,
  operationKey: string,
  inputDigest: string,
  record: ReceivingDraftRecord | ReceivingLiveRecord,
  format: Format,
): Promise<Result> {
  const result =
    format === "versioned"
      ? receivingOperationReceiptV2Schema.parse({
          receiptVersion: 2,
          command,
          operationKey,
          inputDigest,
          eventId: record.id,
          record,
        })
      : parseReceivingRecord(record);
  await tx
    .insert(schema.receivingOperations)
    .values({ tenantId, command, operationKey, inputDigest, eventId: record.id, result });
  return result;
}

async function audit(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  requestId: string,
  before: ReceivingDraftRecord | ReceivingLiveRecord | null,
  after: ReceivingDraftRecord | ReceivingLiveRecord,
) {
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: tenantId,
    actorUserId,
    action: before ? "traceability.receiving.draft_saved" : "traceability.receiving.draft_created",
    outcome: "success",
    targetType: "traceability_event",
    targetId: after.id,
    before,
    after,
    requestId,
  });
}

export function createReceivingDraftCommand(
  db: Db,
  tenantId: string,
  actorUserId: string,
  input: unknown,
  requestId: string,
  format: "legacy",
): Promise<ReceivingDraftRecord>;
export function createReceivingDraftCommand(
  db: Db,
  tenantId: string,
  actorUserId: string,
  input: unknown,
  requestId: string,
  format: "versioned",
): Promise<Result>;
export function createReceivingDraftCommand(
  db: Db,
  tenantId: string,
  actorUserId: string,
  input: unknown,
  requestId: string,
  format: Format,
): Promise<Result> {
  return transaction(db, format, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
    const value = parseMasterDataInput(createReceivingDraftSchema, input);
    const stored = await lockReceivingOperation(
      tx,
      tenantId,
      "receiving.create",
      value.operationKey,
    );
    const legacyDigest = digest(value);
    if (stored)
      return replay(
        stored,
        "receiving.create",
        value.operationKey,
        legacyDigest,
        receivingLifecycleCommandDigest("receiving.create", stored.eventId, value),
        format,
      );
    await assertReceivingReferences(tx, tenantId, value.draft);
    // Authorization holds the organization profile/timezone lock through commit.
    const [profile] = await tx
      .select({ timeZone: schema.orgProfiles.timeZone })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile) throw unavailable();
    const now = new Date();
    const year = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: profile.timeZone, year: "numeric" }).format(now),
    );
    const [counter] = await tx
      .insert(counters)
      .values({ tenantId, year, sequence: 1 })
      .onConflictDoUpdate({
        target: [counters.tenantId, counters.year],
        set: { sequence: sql`${counters.sequence} + 1` },
      })
      .returning();
    if (!counter) throw unavailable();
    const eventNumber = `REC-${String(year).slice(-2).padStart(2, "0")}-${String(counter.sequence).padStart(4, "0")}`;
    const eventId = randomUUID();
    await createReceivingRoot(tx, { tenantId, eventId, eventNumber });
    const [header] = await tx
      .insert(events)
      .values({
        ...receivingHeader(value.draft),
        id: eventId,
        rootEventId: eventId,
        tenantId,
        eventNumber,
        timeZone: profile.timeZone,
        createdBy: actorUserId,
        updatedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: events.id });
    if (!header) throw unavailable();
    await replaceReceivingChildren(tx, tenantId, eventId, value.draft);
    const result =
      format === "versioned"
        ? await readReceivingLiveRecord(tx, tenantId, eventId)
        : await readReceivingDraft(tx, tenantId, eventId, "update");
    await audit(tx, tenantId, actorUserId, requestId, null, result);
    const inputDigest =
      format === "versioned"
        ? receivingLifecycleCommandDigest("receiving.create", eventId, value)
        : legacyDigest;
    return remember(
      tx,
      tenantId,
      "receiving.create",
      value.operationKey,
      inputDigest,
      result,
      format,
    );
  });
}

export function saveOriginalReceivingDraftCommand(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
  format: "legacy",
): Promise<ReceivingDraftRecord>;
export function saveOriginalReceivingDraftCommand(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
  format: "versioned",
): Promise<Result>;
export function saveOriginalReceivingDraftCommand(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
  format: Format,
): Promise<Result> {
  return transaction(db, format, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
    const eventId = parseMasterDataInput(platformUuidSchema, id);
    const value = parseMasterDataInput(saveReceivingDraftSchema, input);
    const legacyDigest = digest({ eventId, ...value });
    const versionedDigest = receivingLifecycleCommandDigest("receiving.save", eventId, value);
    const stored = await lockReceivingOperation(tx, tenantId, "receiving.save", value.operationKey);
    if (stored)
      return replay(
        stored,
        "receiving.save",
        value.operationKey,
        legacyDigest,
        versionedDigest,
        format,
        eventId,
      );
    await lockReceivingRoot(tx, tenantId, eventId);
    await assertOriginalReceivingWriteTarget(tx, tenantId, eventId);
    const before = await readReceivingDraft(tx, tenantId, eventId, "update");
    if (before.draftVersion !== value.expectedDraftVersion)
      throw new ConflictException({ code: "receiving_draft_conflict" });
    const auditBefore =
      format === "versioned" ? await readReceivingLiveRecord(tx, tenantId, eventId) : before;
    const inputDigest = format === "versioned" ? versionedDigest : legacyDigest;
    if (isDeepStrictEqual(comparableDraft(before.draft), comparableDraft(value.draft))) {
      return remember(
        tx,
        tenantId,
        "receiving.save",
        value.operationKey,
        inputDigest,
        auditBefore,
        format,
      );
    }
    await assertReceivingReferences(tx, tenantId, value.draft);
    await tx
      .update(events)
      .set({
        ...receivingHeader(value.draft),
        draftVersion: before.draftVersion + 1,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)));
    await replaceReceivingChildren(tx, tenantId, eventId, value.draft);
    const result =
      format === "versioned"
        ? await readReceivingLiveRecord(tx, tenantId, eventId)
        : await readReceivingDraft(tx, tenantId, eventId, "update");
    await audit(tx, tenantId, actorUserId, requestId, auditBefore, result);
    return remember(
      tx,
      tenantId,
      "receiving.save",
      value.operationKey,
      inputDigest,
      result,
      format,
    );
  });
}
