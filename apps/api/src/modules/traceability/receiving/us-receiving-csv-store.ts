import { NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { receivingTransaction } from "./us-receiving-operations";
import { prepareUsReceivingCsvFile } from "./us-receiving-csv-input";
import {
  buildReceivingCsvProposal,
  csvPreviewUnavailable,
  receivingCsvPreviewResponse,
} from "./us-receiving-csv-preview";
import { resolveReceivingCsvReferences } from "./us-receiving-csv-references";
import { applyReceivingCsvPreview } from "./us-receiving-csv-apply";

const previews = schema.receivingCsvPreviews;

/** Tenant-scoped persistence; only the isolated US HTTP composition exposes this service. */
export class UsReceivingCsvStore {
  constructor(private readonly db: Db) {}

  applyPreview(
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ) {
    return applyReceivingCsvPreview(this.db, tenantId, actorUserId, id, input, requestId);
  }

  createPreview(tenantId: string, actorUserId: string, input: unknown, requestId: string) {
    return receivingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
      const prepared = prepareUsReceivingCsvFile(input);
      const resolution = await resolveReceivingCsvReferences(tx, tenantId, prepared);
      const proposal = buildReceivingCsvProposal(prepared, resolution);
      const now = new Date();
      const [row] = await tx
        .insert(previews)
        .values({
          tenantId,
          templateVersion: prepared.input.templateVersion,
          fileBytes: Buffer.from(prepared.fileBytes),
          byteSize: prepared.byteSize,
          fileSha256: prepared.fileSha256,
          fileName: prepared.input.fileName ?? null,
          originalHeader: prepared.originalHeader,
          findings: { version: 1, content: prepared.content, resolution },
          ...proposal,
          rowCount: prepared.content.ok ? prepared.content.rows.length : 0,
          createdBy: actorUserId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86400000),
        })
        .returning();
      if (!row) throw csvPreviewUnavailable();
      const result = receivingCsvPreviewResponse(row);
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.receiving.csv_previewed",
        outcome: "success",
        targetType: "receiving_csv_preview",
        targetId: row.id,
        before: null,
        requestId,
        after: {
          importId: row.id,
          templateVersion: row.templateVersion,
          fileSha256: row.fileSha256,
          rowCount: row.rowCount,
          hasProposal: row.proposedDraft !== null,
          previewDigest: row.previewDigest,
        },
      });
      return result;
    });
  }

  getPreview(tenantId: string, actorUserId: string, id: unknown) {
    return receivingTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
      const previewId = parseMasterDataInput(platformUuidSchema, id);
      const [row] = await tx
        .select()
        .from(previews)
        .where(and(eq(previews.tenantId, tenantId), eq(previews.id, previewId)))
        .limit(1);
      if (!row) throw new NotFoundException({ code: "receiving_csv_preview_not_found" });
      return receivingCsvPreviewResponse(row);
    });
  }
}
