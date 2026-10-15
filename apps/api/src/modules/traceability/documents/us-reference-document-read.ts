import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, type ReferenceDocument } from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { RawDocument } from "../demo/us-dataset-terminal-read-contract";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { referenceDocumentResponse } from "./us-reference-document-support";

export type UsReferenceDocumentReaders = Readonly<{
  authorize: typeof authorizeUsMasterData;
  document(
    tx: UsMasterDataTransaction,
    tenantId: string,
    id: string,
  ): Promise<RawDocument | undefined>;
}>;

async function freshDocument(tx: UsMasterDataTransaction, tenantId: string, id: string) {
  const [row] = await tx
    .select()
    .from(schema.referenceDocuments)
    .where(
      and(eq(schema.referenceDocuments.tenantId, tenantId), eq(schema.referenceDocuments.id, id)),
    )
    .limit(1);
  return row;
}

export const freshUsReferenceDocumentReaders: UsReferenceDocumentReaders = {
  authorize: authorizeUsMasterData,
  document: freshDocument,
};

export async function readUsReferenceDocumentCore(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  readers: UsReferenceDocumentReaders,
): Promise<ReferenceDocument> {
  await readers.authorize(tx, tenantId, actorUserId, US_CAPABILITY.READ);
  const documentId = parseMasterDataInput(platformUuidSchema, id);
  const row = await readers.document(tx, tenantId, documentId);
  if (!row) throw new NotFoundException({ code: "document_not_found" });
  return referenceDocumentResponse(row);
}
