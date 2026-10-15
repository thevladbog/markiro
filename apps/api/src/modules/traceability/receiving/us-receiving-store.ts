import { ConflictException } from "@nestjs/common";
import { US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  listReceivingDraftsQuerySchema,
  receivingDraftListSchema,
  listReceivingRecordsQuerySchema,
  receivingRecordListSchema,
  receivingReadinessQuerySchema,
  receivingCreateResultSchema,
  receivingSaveResultSchema,
  platformUuidSchema,
  receivingBasisQuerySchema,
  receivingRevisionListQuerySchema,
  listReceivingLiveRecordsQuerySchema,
  type ReceivingDraftList,
  type ReceivingDraftRecord,
  type ReceivingReadiness,
  type ReceivingCreateResult,
  type ReceivingFinalizeResult,
  type ReceivingRevisionReadiness,
  type ReceivingLiveRecord,
  type ReceivingBasis,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  escapeLikePattern,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readReceivingReadiness } from "./us-receiving-readiness";
import { readReceivingDraft, readReceivingRecord, unavailable } from "./us-receiving-persistence";
import { finalizeReceiving } from "./us-receiving-finalization";
import {
  freshReceivingBasisReaders,
  readReceivingBasisCore,
  type ReceivingBasisReaders,
} from "./us-receiving-basis";
import {
  freshReceivingHistoryReaders,
  readReceivingLiveRecordCore,
  readReceivingRevisions,
  type ReceivingHistoryReaders,
} from "./us-receiving-history";
import {
  executeReceivingLifecycle,
  executeReceivingLifecycleInTransaction,
} from "./us-receiving-lifecycle";
import {
  saveReceivingAmendment,
  saveReceivingAmendmentInTransaction,
} from "./us-receiving-amendment-save";
import { readReceivingRevisionContext } from "./us-receiving-revision-readiness";
import {
  finalizeReceivingRevision,
  finalizeReceivingCommand,
  finalizeReceivingCommandInTransaction,
} from "./us-receiving-revision-finalization";
import { readReceivingRegistry } from "./us-receiving-registry";
import {
  createReceivingDraftCommand,
  createReceivingDraftCommandInTransaction,
  saveOriginalReceivingDraftCommand,
} from "./us-receiving-draft-commands";
import { exportReceivingCsv } from "./us-receiving-csv-export";

const events = schema.traceabilityEvents,
  items = schema.receivingEventItems,
  documents = schema.receivingEventDocuments;

export type UsReceivingNativeReaders = Readonly<{
  authorize: typeof authorizeUsMasterData;
  history: ReceivingHistoryReaders;
  basis: ReceivingBasisReaders;
}>;

export const freshUsReceivingNativeReaders: UsReceivingNativeReaders = {
  authorize: authorizeUsMasterData,
  history: freshReceivingHistoryReaders,
  basis: freshReceivingBasisReaders,
};

export async function readUsReceivingLiveRecordCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  readers: UsReceivingNativeReaders,
): Promise<ReceivingLiveRecord> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  return readReceivingLiveRecordCore(
    tx,
    tenantId,
    parseMasterDataInput(platformUuidSchema, id),
    readers.history,
  );
}

export async function readUsReceivingBasisCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  lotId: unknown,
  query: unknown,
  readers: UsReceivingNativeReaders,
): Promise<ReceivingBasis> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  return readReceivingBasisCore(
    tx,
    tenantId,
    parseMasterDataInput(platformUuidSchema, lotId),
    parseMasterDataInput(receivingBasisQuerySchema, query),
    readers.basis,
  );
}

export class UsReceivingStore {
  constructor(private readonly db: Db) {}

  exportCsv(tenantId: string, actorUserId: string, id: unknown, query: unknown, requestId: string) {
    return exportReceivingCsv(this.db, tenantId, actorUserId, id, query, requestId);
  }

  // Authorizes before parsing either original or explicit revision HTTP input.
  finalizeCommand(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ) {
    return finalizeReceivingCommand(this.db, tenantId, actorUserId, id, input, requestId);
  }

  /** Caller owns the complete transaction and any retry; no nested transaction is started. */
  finalizeCommandInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingFinalizeResult> {
    return finalizeReceivingCommandInTransaction(tx, tenantId, actorUserId, id, input, requestId);
  }

  finalizeRevision(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ) {
    return finalizeReceivingRevision(this.db, tenantId, actorUserId, id, input, requestId);
  }

  // Live readiness binds both original and amendment commands to current lifecycle state.
  async checkRevisionReadiness(tenantId: string, actorUserId: string, id: unknown, query: unknown) {
    return this.db.transaction(
      (tx) => this.checkRevisionReadinessInTransaction(tx, tenantId, actorUserId, id, query),
      { isolationLevel: "repeatable read" },
    );
  }

  /**
   * Multi-statement current-state readers require caller-owned repeatable read or a sufficient
   * explicit lock protocol. Reading this transaction's own fresh writes does not establish a
   * general read-committed snapshot guarantee. These readers choose no isolation or global lock.
   */
  async checkRevisionReadinessInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    query: unknown,
  ): Promise<ReceivingRevisionReadiness> {
    const profileCode = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
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

  /** Caller owns the complete transaction and any retry; no nested transaction is started. */
  amendInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingOperationReceiptV2> {
    return executeReceivingLifecycleInTransaction(
      tx,
      tenantId,
      actorUserId,
      "receiving.amend",
      id,
      input,
      requestId,
    );
  }

  /** Caller owns the complete transaction and any retry; no nested transaction is started. */
  voidInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingOperationReceiptV2> {
    return executeReceivingLifecycleInTransaction(
      tx,
      tenantId,
      actorUserId,
      "receiving.void",
      id,
      input,
      requestId,
    );
  }

  /** Caller owns the complete transaction and any retry; no nested transaction is started. */
  saveAmendmentInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingOperationReceiptV2> {
    return saveReceivingAmendmentInTransaction(tx, tenantId, actorUserId, id, input, requestId);
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

  // Current authorized HTTP registry, distinct from historical command receipts.
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
      (tx) => this.getLiveRecordInTransaction(tx, tenantId, actorUserId, id),
      { isolationLevel: "repeatable read" },
    );
  }

  /** Caller supplies repeatable read or sufficient explicit locks for current-state verification. */
  async getLiveRecordInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
  ): Promise<ReceivingLiveRecord> {
    return readUsReceivingLiveRecordCore(
      tx,
      tenantId,
      actorUserId,
      id,
      freshUsReceivingNativeReaders,
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

  /** Caller supplies repeatable read or sufficient explicit locks for token/count/page consistency. */
  async getLotReceivingBasisInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    lotId: unknown,
    query: unknown,
  ): Promise<ReceivingBasis> {
    return readUsReceivingBasisCore(
      tx,
      tenantId,
      actorUserId,
      lotId,
      query,
      freshUsReceivingNativeReaders,
    );
  }

  async getLotReceivingBasis(
    tenantId: string,
    actorUserId: string,
    lotId: unknown,
    query: unknown,
  ) {
    return this.db.transaction(
      (tx) => this.getLotReceivingBasisInTransaction(tx, tenantId, actorUserId, lotId, query),
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

  createDraft(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingDraftRecord> {
    return createReceivingDraftCommand(this.db, tenantId, actorUserId, input, requestId, "legacy");
  }

  saveDraft(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingDraftRecord> {
    return saveOriginalReceivingDraftCommand(
      this.db,
      tenantId,
      actorUserId,
      id,
      input,
      requestId,
      "legacy",
    );
  }

  // HTTP acknowledgement bridge; stored historical response formats stay pinned.
  async createDraftCommand(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ) {
    return receivingCreateResultSchema.parse(
      await createReceivingDraftCommand(
        this.db,
        tenantId,
        actorUserId,
        input,
        requestId,
        "versioned",
      ),
    );
  }

  /** Caller owns commit/rollback and any retry of the complete transaction. */
  async createDraftCommandInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<ReceivingCreateResult> {
    return receivingCreateResultSchema.parse(
      await createReceivingDraftCommandInTransaction(
        tx,
        tenantId,
        actorUserId,
        input,
        requestId,
        "versioned",
      ),
    );
  }

  async saveOriginalDraftCommand(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ) {
    return receivingSaveResultSchema.parse(
      await saveOriginalReceivingDraftCommand(
        this.db,
        tenantId,
        actorUserId,
        id,
        input,
        requestId,
        "versioned",
      ),
    );
  }
}
