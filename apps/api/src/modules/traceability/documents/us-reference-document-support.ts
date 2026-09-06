import { ServiceUnavailableException } from "@nestjs/common";
import type { schema } from "@markiro/db";
import { referenceDocumentSchema, type ReferenceDocument } from "@markiro/platform-contracts";

export function referenceDocumentResponse(
  row: typeof schema.referenceDocuments.$inferSelect,
): ReferenceDocument {
  const parsed = referenceDocumentSchema.safeParse({
    id: row.id,
    type: row.type,
    typeOtherLabel: row.typeOtherLabel,
    number: row.number,
    partyId: row.partyId,
    issuedOn: row.issuedOn,
    notes: row.notes,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
  return parsed.data;
}
