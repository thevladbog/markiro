import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { US_CAPABILITY } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  listReferenceDocumentsQuerySchema,
  platformUuidSchema,
  referenceDocumentInputSchema,
  type ReferenceDocument,
  type ReferenceDocumentList,
} from "@markiro/platform-contracts";
import { and, asc, eq, ilike, isNotNull, isNull } from "drizzle-orm";
import {
  authorizeUsMasterData,
  escapeLikePattern,
  isUniqueConstraintViolation,
  parseMasterDataInput,
} from "../master-data/us-master-data-support";
import { referenceDocumentResponse } from "./us-reference-document-support";

const documents = schema.referenceDocuments;
const writers = [
  US_CAPABILITY.RECEIVING_WRITE,
  US_CAPABILITY.TRANSFORMATION_WRITE,
  US_CAPABILITY.SHIPPING_WRITE,
] as const;

/** Metadata registry only; event links, edits and frozen snapshots are separate boundaries. */
export class UsReferenceDocumentStore {
  constructor(private readonly db: Db) {}

  async listDocuments(
    tenantId: string,
    actorUserId: string,
    query: unknown,
  ): Promise<ReferenceDocumentList> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const value = parseMasterDataInput(listReferenceDocumentsQuerySchema, query);
      const rows = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            value.type ? eq(documents.type, value.type) : undefined,
            value.partyId ? eq(documents.partyId, value.partyId) : undefined,
            value.archived === "all"
              ? undefined
              : value.archived === "true"
                ? isNotNull(documents.archivedAt)
                : isNull(documents.archivedAt),
            value.search
              ? ilike(documents.number, `%${escapeLikePattern(value.search)}%`)
              : undefined,
          ),
        )
        .orderBy(asc(documents.number), asc(documents.id))
        .limit(value.limit)
        .offset(value.offset);
      return {
        items: rows.map(referenceDocumentResponse),
        limit: value.limit,
        offset: value.offset,
      };
    });
  }

  async getDocument(
    tenantId: string,
    actorUserId: string,
    id: unknown,
  ): Promise<ReferenceDocument> {
    return this.db.transaction(async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      const documentId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
        .limit(1);
      if (!row) throw new NotFoundException({ code: "document_not_found" });
      return referenceDocumentResponse(row);
    });
  }

  async createDocument(
    tenantId: string,
    actorUserId: string,
    input: unknown,
    requestId: string,
  ): Promise<ReferenceDocument> {
    try {
      return await this.db.transaction(async (tx) => {
        await authorizeUsMasterData(tx, tenantId, actorUserId, writers);
        const value = parseMasterDataInput(referenceDocumentInputSchema, input);
        if (value.partyId !== null) {
          const [party] = await tx
            .select({ id: schema.traceabilityParties.id })
            .from(schema.traceabilityParties)
            .where(
              and(
                eq(schema.traceabilityParties.tenantId, tenantId),
                eq(schema.traceabilityParties.id, value.partyId),
                eq(schema.traceabilityParties.archived, false),
              ),
            )
            .limit(1)
            .for("share");
          if (!party) throw new NotFoundException({ code: "party_not_found" });
        }
        const now = new Date();
        const [row] = await tx
          .insert(documents)
          .values({ ...value, tenantId, createdBy: actorUserId, createdAt: now, updatedAt: now })
          .returning();
        if (!row) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
        const result = referenceDocumentResponse(row);
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "traceability.reference_document.created",
          outcome: "success",
          targetType: "traceability_reference_document",
          targetId: row.id,
          before: null,
          after: result,
          requestId,
        });
        return result;
      });
    } catch (error) {
      if (
        ["reference_documents_with_party_uq", "reference_documents_without_party_uq"].some(
          (constraint) => isUniqueConstraintViolation(error, constraint),
        )
      )
        throw new ConflictException({ code: "document_duplicate" });
      throw error;
    }
  }
}
