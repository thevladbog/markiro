import { createHash } from "node:crypto";
import {
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  encodeReceivingCsvExport,
  platformUuidSchema,
  receivingCsvExportQuerySchema,
  RECEIVING_CSV_EXPORT_VERSION,
  ReceivingCsvExportError,
} from "@markiro/platform-contracts";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";

/** A generated export is an audited read. No Receiving business row is updated. */
export async function exportReceivingCsv(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  query: unknown,
  requestId: string,
) {
  return db.transaction(
    async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.EXPORT_READ);
      const eventId = parseMasterDataInput(platformUuidSchema, id);
      const expected = parseMasterDataInput(receivingCsvExportQuerySchema, query);
      const record = await readReceivingLiveRecord(tx, tenantId, eventId);
      if (
        record.draftVersion !== expected.expectedDraftVersion ||
        record.lifecycle.lifecycleVersion !== expected.expectedLifecycleVersion
      )
        throw new ConflictException({ code: "receiving_export_stale" });
      const capturedAt = new Date().toISOString();
      let bytes: Uint8Array;
      try {
        bytes = encodeReceivingCsvExport(record, capturedAt);
      } catch (error) {
        if (error instanceof ReceivingCsvExportError && error.code === "export_value_too_large")
          throw new UnprocessableEntityException({
            code: error.code,
            row: error.row ?? null,
            column: error.column ?? null,
          });
        throw new ServiceUnavailableException({ code: "receiving_export_unavailable" });
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const itemCount =
        record.content.kind === "draft"
          ? record.content.draft.items.length
          : record.content.snapshot.items.length;
      const documentCount =
        record.content.kind === "draft"
          ? record.content.draft.documentIds.length
          : record.content.snapshot.documents.length;
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "traceability.receiving.csv_generated",
        outcome: "success",
        targetType: "traceability_event",
        targetId: record.id,
        before: null,
        after: {
          eventId: record.id,
          revision: record.revision,
          draftVersion: record.draftVersion,
          lifecycleVersion: record.lifecycle.lifecycleVersion,
          status: record.status,
          contentKind: record.content.kind,
          formatVersion: RECEIVING_CSV_EXPORT_VERSION,
          capturedAt,
          itemCount,
          documentCount,
          byteCount: bytes.byteLength,
          sha256,
        },
        requestId,
      });
      return {
        bytes,
        sha256,
        fileName: `markiro-receiving-${record.id.toLowerCase()}-r${record.revision}-d${record.draftVersion}-l${record.lifecycle.lifecycleVersion}.csv`,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}
