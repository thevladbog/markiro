import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConflictException } from "@nestjs/common";
import { US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  createReceivingDraftSchema,
  listReceivingDraftsQuerySchema,
  receivingDraftListSchema,
  listReceivingRecordsQuerySchema,
  receivingRecordListSchema,
  receivingReadinessQuerySchema,
  saveReceivingDraftSchema,
  platformUuidSchema,
  receivingBasisQuerySchema,
  receivingRevisionListQuerySchema,
  listReceivingLiveRecordsQuerySchema,
  type ReceivingDraftList,
  type ReceivingDraft,
  type ReceivingDraftRecord,
  type ReceivingReadiness,
} from "@markiro/platform-contracts";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  escapeLikePattern,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { assertReceivingReferences } from "./us-receiving-references";
import { readReceivingReadiness } from "./us-receiving-readiness";
import {
  parseReceivingRecord,
  readReceivingDraft,
  readReceivingRecord,
  receivingHeader,
  replaceReceivingChildren,
  unavailable,
} from "./us-receiving-persistence";
import { finalizeReceiving } from "./us-receiving-finalization";
import { createReceivingRoot, lockReceivingRoot } from "./us-receiving-roots";
import { readReceivingBasis } from "./us-receiving-basis";
import { readReceivingLiveRecord, readReceivingRevisions } from "./us-receiving-history";
import { executeReceivingLifecycle } from "./us-receiving-lifecycle";
import { lockReceivingOperation } from "./us-receiving-operations";
import { saveReceivingAmendment } from "./us-receiving-amendment-save";
import { readReceivingRevisionContext } from "./us-receiving-revision-readiness";
import { finalizeReceivingRevision } from "./us-receiving-revision-finalization";
import { readReceivingRegistry } from "./us-receiving-registry";

const events = schema.traceabilityEvents,
  items = schema.receivingEventItems,
  documents = schema.receivingEventDocuments,
  operations = schema.receivingOperations,
  counters = schema.receivingCounters;
type Command = "receiving.create" | "receiving.save";
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

// Comparison only: old operation digests and remembered payloads retain their original shapes.
function comparableDraft(draft: ReceivingDraft) {
  return {
    ...draft,
    items: draft.items.map(({ exemptReceipt, ...item }) => ({
      ...item,
      exemptReceipt: exemptReceipt ?? null,
    })),
  };
}

export class UsReceivingStore {
  constructor(private readonly db: Db) {}

  finalizeRevision(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ) {
    return finalizeReceivingRevision(this.db, tenantId, actorUserId, id, input, requestId);
  }

  // Internal until the coordinated lifecycle HTTP/response switch.
  async checkRevisionReadiness(tenantId: string, actorUserId: string, id: unknown, query: unknown) {
    return this.db.transaction(
      async (tx) => {
        const profileCode = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.READ,
        );
        const eventId = parseMasterDataInput(platformUuidSchema, id);
        const value = parseMasterDataInput(receivingReadinessQuerySchema, query);
        return (
          await readReceivingRevisionContext(
            tx,
            tenantId,
            eventId,
            value.expectedDraftVersion,
            profileCode,
          )
        ).readiness;
      },
      { isolationLevel: "repeatable read" },
    );
  }

  saveAmendment(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ) {
    return saveReceivingAmendment(this.db, tenantId, actorUserId, id, input, requestId);
  }

  amend(tenantId: string, actorUserId: string, id: unknown, input: unknown, requestId: string) {
    return executeReceivingLifecycle(
      this.db,
      tenantId,
      actorUserId,
      "receiving.amend",
      id,
      input,
      requestId,
    );
  }

  void(tenantId: string, actorUserId: string, id: unknown, input: unknown, requestId: string) {
    return executeReceivingLifecycle(
      this.db,
      tenantId,
      actorUserId,
      "receiving.void",
      id,
      input,
      requestId,
    );
  }

  // Additive server foundation; HTTP activation belongs to the complete lifecycle switch.
  async listLiveRecords(tenantId: string, actorUserId: string, query: unknown) {
    return this.db.transaction(
      async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return readReceivingRegistry(
          tx,
          tenantId,
          parseMasterDataInput(listReceivingLiveRecordsQuerySchema, query),
        );
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async getLiveRecord(tenantId: string, actorUserId: string, id: unknown) {
    return this.db.transaction(
      async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return readReceivingLiveRecord(tx, tenantId, parseMasterDataInput(platformUuidSchema, id));
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async listRevisions(tenantId: string, actorUserId: string, id: unknown, query: unknown) {
    return this.db.transaction(
      async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return readReceivingRevisions(
          tx,
          tenantId,
          parseMasterDataInput(platformUuidSchema, id),
          parseMasterDataInput(receivingRevisionListQuerySchema, query),
        );
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async getLotReceivingBasis(
    tenantId: string,
    actorUserId: string,
    lotId: unknown,
    query: unknown,
  ) {
    return this.db.transaction(
      async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
        return readReceivingBasis(
          tx,
          tenantId,
          parseMasterDataInput(platformUuidSchema, lotId),
          parseMasterDataInput(receivingBasisQuerySchema, query),
        );
      },
      { isolationLevel: "repeatable read" },
    );
  }

  finalize(tenantId: string, actorUserId: string, id: unknown, input: unknown, requestId: string) {
    return finalizeReceiving(this.db, tenantId, actorUserId, id, input, requestId);
  }

  async getRecord(tenantId: string, actorUserId: string, id: unknown) {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      return readReceivingRecord(
        tx,
        tenantId,
        parseMasterDataInput(platformUuidSchema, id),
        "share",
      );
    });
  }

  async checkReadiness(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    query: unknown,
  ): Promise<ReceivingReadiness> {
    return this.db.transaction(
      async (tx) => {
        const profileCode = await authorizeUsMasterData(
          tx,
          tenantId,
          actorUserId,
          US_CAPABILITY.READ,
        );
        const eventId = parseMasterDataInput(platformUuidSchema, id);
        const value = parseMasterDataInput(receivingReadinessQuerySchema, query);
        const saved = await readReceivingDraft(tx, tenantId, eventId, "share");
        if (saved.draftVersion !== value.expectedDraftVersion)
          throw new ConflictException({ code: "receiving_draft_conflict" });
        return readReceivingReadiness(tx, tenantId, saved, profileCode);
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async listDrafts(
    tenantId: string,
    actorUserId: string,
    query: unknown,
  ): Promise<ReceivingDraftList> {
    const value = parseMasterDataInput(listReceivingDraftsQuerySchema, query);
    const result = receivingDraftListSchema.safeParse(
      await this.listRecords(tenantId, actorUserId, { ...value, status: "draft" }),
    );
    if (!result.success) throw unavailable();
    return result.data;
  }

  async listRecords(tenantId: string, actorUserId: string, query: unknown) {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const value = parseMasterDataInput(listReceivingRecordsQuerySchema, query);
      const rows = await tx
        .select({
          id: events.id,
          eventNumber: events.eventNumber,
          status: events.status,
          revision: events.revision,
          draftVersion: events.draftVersion,
          timeZone: events.timeZone,
          createdBy: events.createdBy,
          updatedBy: events.updatedBy,
          createdAt: events.createdAt,
          updatedAt: events.updatedAt,
          dateReceived: events.dateReceived,
          locationId: events.locationId,
          previousSourceLocationId: events.previousSourceLocationId,
          lineCount: sql<number>`(
            SELECT count(*)::int
            FROM ${items}
            WHERE ${items.tenantId} = ${events.tenantId}
              AND ${items.eventId} = ${events.id}
          )`,
          documentCount: sql<number>`(
            SELECT count(*)::int
            FROM ${documents}
            WHERE ${documents.tenantId} = ${events.tenantId}
              AND ${documents.eventId} = ${events.id}
          )`,
        })
        .from(events)
        .where(
          and(
            eq(events.tenantId, tenantId),
            eq(events.type, "receiving"),
            value.status ? eq(events.status, value.status) : undefined,
            value.search
              ? ilike(events.eventNumber, `%${escapeLikePattern(value.search)}%`)
              : undefined,
          ),
        )
        .orderBy(desc(events.createdAt), desc(events.id))
        .limit(value.limit)
        .offset(value.offset);
      const result = receivingRecordListSchema.safeParse({
        items: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        limit: value.limit,
        offset: value.offset,
      });
      if (!result.success) throw unavailable();
      return result.data;
    });
  }

  async getDraft(
    tenantId: string,
    actorUserId: string,
    id: unknown,
  ): Promise<ReceivingDraftRecord> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      return readReceivingDraft(
        tx,
        tenantId,
        parseMasterDataInput(platformUuidSchema, id),
        "share",
      );
    });
  }

  async createDraft(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingDraftRecord> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
      const value = parseMasterDataInput(createReceivingDraftSchema, input);
      const inputDigest = digest(value);
      const replay = await this.replay(
        tx,
        tenantId,
        "receiving.create",
        value.operationKey,
        inputDigest,
      );
      if (replay) return replay;
      await assertReceivingReferences(tx, tenantId, value.draft);
      // authorizeUsMasterData already holds the profile/timezone lock through commit.
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
      await replaceReceivingChildren(tx, tenantId, header.id, value.draft);
      const result = await readReceivingDraft(tx, tenantId, header.id, "update");
      await this.audit(tx, tenantId, actorUserId, requestId, null, result);
      await this.remember(
        tx,
        tenantId,
        "receiving.create",
        value.operationKey,
        inputDigest,
        result,
      );
      return result;
    });
  }

  async saveDraft(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingDraftRecord> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
      const eventId = parseMasterDataInput(platformUuidSchema, id);
      const value = parseMasterDataInput(saveReceivingDraftSchema, input);
      const inputDigest = digest({ eventId, ...value });
      const replay = await this.replay(
        tx,
        tenantId,
        "receiving.save",
        value.operationKey,
        inputDigest,
      );
      if (replay) return replay;
      await lockReceivingRoot(tx, tenantId, eventId);
      const before = await readReceivingDraft(tx, tenantId, eventId, "update");
      if (before.draftVersion !== value.expectedDraftVersion)
        throw new ConflictException({ code: "receiving_draft_conflict" });
      if (isDeepStrictEqual(comparableDraft(before.draft), comparableDraft(value.draft))) {
        await this.remember(
          tx,
          tenantId,
          "receiving.save",
          value.operationKey,
          inputDigest,
          before,
        );
        return before;
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
      const result = await readReceivingDraft(tx, tenantId, eventId, "update");
      await this.audit(tx, tenantId, actorUserId, requestId, before, result);
      await this.remember(tx, tenantId, "receiving.save", value.operationKey, inputDigest, result);
      return result;
    });
  }

  private async replay(
    tx: UsMasterDataTransaction,
    tenantId: string,
    command: Command,
    operationKey: string,
    inputDigest: string,
  ) {
    const receipt = await lockReceivingOperation(tx, tenantId, command, operationKey);
    if (!receipt) return null;
    if (receipt.inputDigest !== inputDigest)
      throw new ConflictException({ code: "receiving_operation_conflict" });
    const result = parseReceivingRecord(receipt.result);
    if (result.id !== receipt.eventId) throw unavailable();
    return result;
  }

  private async remember(
    tx: UsMasterDataTransaction,
    tenantId: string,
    command: Command,
    operationKey: string,
    inputDigest: string,
    result: ReceivingDraftRecord,
  ) {
    await tx
      .insert(operations)
      .values({ tenantId, command, operationKey, inputDigest, eventId: result.id, result });
  }

  private async audit(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    requestId: string,
    before: ReceivingDraftRecord | null,
    after: ReceivingDraftRecord,
  ) {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: before
        ? "traceability.receiving.draft_saved"
        : "traceability.receiving.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      targetId: after.id,
      before,
      after,
      requestId,
    });
  }
}
