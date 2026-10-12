import type { Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  transformationRevisionListQuerySchema,
  type TransformationRevisionList,
  type TransformationDraftRecord,
  type TransformationReadiness,
  type TransformationFinalizedRecord,
} from "@markiro/platform-contracts";
import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import {
  createTransformationDraft,
  createTransformationDraftInTransaction,
  saveTransformationDraft,
} from "./us-transformation-draft";
import { transformationTransaction } from "./us-transformation-operations";
import { readTransformationDraft, readTransformationRecord } from "./us-transformation-persistence";
import { readTransformationReadiness } from "./us-transformation-readiness";
import {
  finalizeTransformation,
  finalizeTransformationInTransaction,
} from "./us-transformation-finalization";
import { executeTransformationLifecycle } from "./us-transformation-lifecycle";
import { readTransformationGenealogy } from "./us-transformation-genealogy";
import { readTransformationRevisions } from "./us-transformation-revisions";

const readinessQuery = z
  .object({ expectedDraftVersion: z.number().int().min(1).max(2147483647) })
  .strict();
/** Internal US command boundary. No HTTP surface or runtime registration. */
export class UsTransformationStore {
  constructor(private readonly db: Db) {}
  listRevisions(
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    query: unknown,
  ): Promise<TransformationRevisionList> {
    return transformationTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const id = parseMasterDataInput(platformUuidSchema, eventId);
      const page = parseMasterDataInput(transformationRevisionListQuerySchema, query);
      return readTransformationRevisions(tx, tenantId, id, page);
    });
  }
  getGenealogy(tenantId: string, actorUserId: string, input: unknown) {
    return readTransformationGenealogy(this.db, tenantId, actorUserId, input);
  }
  createDraft(tenantId: string, actorUserId: string, input: unknown, requestId: string) {
    return createTransformationDraft(this.db, tenantId, actorUserId, input, requestId);
  }
  createDraftInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<TransformationDraftRecord> {
    return createTransformationDraftInTransaction(tx, tenantId, actorUserId, input, requestId);
  }
  finalize(
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    input: unknown,
    requestId: string,
  ) {
    return finalizeTransformation(this.db, tenantId, actorUserId, eventId, input, requestId);
  }
  finalizeInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<TransformationFinalizedRecord> {
    return finalizeTransformationInTransaction(tx, tenantId, actorUserId, id, input, requestId);
  }
  amend(
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    input: unknown,
    requestId: string,
  ) {
    return executeTransformationLifecycle(
      this.db,
      tenantId,
      actorUserId,
      "transformation.amend",
      eventId,
      input,
      requestId,
    );
  }
  void(tenantId: string, actorUserId: string, eventId: unknown, input: unknown, requestId: string) {
    return executeTransformationLifecycle(
      this.db,
      tenantId,
      actorUserId,
      "transformation.void",
      eventId,
      input,
      requestId,
    );
  }
  saveDraft(
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    input: unknown,
    requestId: string,
  ) {
    return saveTransformationDraft(this.db, tenantId, actorUserId, eventId, input, requestId);
  }
  getRecord(tenantId: string, actorUserId: string, eventId: unknown) {
    return transformationTransaction(this.db, (tx) =>
      this.getRecordInTransaction(tx, tenantId, actorUserId, eventId),
    );
  }
  async getRecordInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
  ): Promise<Awaited<ReturnType<typeof readTransformationRecord>>> {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
    return readTransformationRecord(
      tx,
      tenantId,
      parseMasterDataInput(platformUuidSchema, eventId),
    );
  }
  checkReadiness(tenantId: string, actorUserId: string, eventId: unknown, input: unknown) {
    return transformationTransaction(this.db, (tx) =>
      this.checkReadinessInTransaction(tx, tenantId, actorUserId, eventId, input),
    );
  }
  async checkReadinessInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    eventId: unknown,
    input: unknown,
  ): Promise<TransformationReadiness> {
    const profileCode = await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
    const id = parseMasterDataInput(platformUuidSchema, eventId),
      query = parseMasterDataInput(readinessQuery, input);
    const saved = await readTransformationDraft(tx, tenantId, id);
    if (saved.draftVersion !== query.expectedDraftVersion)
      throw new ConflictException({ code: "transformation_draft_conflict" });
    return readTransformationReadiness(tx, tenantId, saved, profileCode);
  }
}
