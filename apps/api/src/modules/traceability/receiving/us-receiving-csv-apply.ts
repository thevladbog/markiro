import { isDeepStrictEqual } from "node:util";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, receivingCsvApplyInputSchema } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { lockReceivingOperation, receivingTransaction } from "./us-receiving-operations";
import { prepareUsReceivingCsvFile } from "./us-receiving-csv-input";
import { buildReceivingCsvProposal, receivingCsvPreviewResponse } from "./us-receiving-csv-preview";
import { resolveReceivingCsvReferences } from "./us-receiving-csv-references";
import { csvApplyUnavailable, parseReceivingCsvReceipt } from "./us-receiving-csv-receipt";
import { insertReceivingDraft } from "./us-receiving-draft-create";

const command = "receiving.csv.apply";
const previews = schema.receivingCsvPreviews,
  applications = schema.receivingCsvApplications,
  operations = schema.receivingOperations;
const conflict = () => new ConflictException({ code: "receiving_operation_conflict" });
async function binding(tx: UsMasterDataTransaction, tenantId: string, previewId: string) {
  const [row] = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.tenantId, tenantId), eq(applications.previewId, previewId)));
  return row;
}

/** Validate against original saved evidence, not today's event, expiry or catalog. */
async function replay(
  tx: UsMasterDataTransaction,
  tenantId: string,
  stored: typeof operations.$inferSelect,
) {
  const receipt = parseReceivingCsvReceipt(stored.result);
  if (
    stored.tenantId !== tenantId ||
    stored.command !== command ||
    receipt.operationKey !== stored.operationKey ||
    receipt.inputDigest !== stored.inputDigest ||
    receipt.eventId !== stored.eventId
  )
    throw csvApplyUnavailable();
  const [origin] = await tx
    .select()
    .from(previews)
    .where(and(eq(previews.tenantId, tenantId), eq(previews.id, receipt.importId)));
  const link = await binding(tx, tenantId, receipt.importId);
  if (
    !origin ||
    !link ||
    link.command !== command ||
    link.operationKey !== receipt.operationKey ||
    link.inputDigest !== receipt.inputDigest
  )
    throw csvApplyUnavailable();
  const saved = receivingCsvPreviewResponse(origin);
  if (
    saved.previewDigest !== receipt.inputDigest ||
    receipt.record.content.kind !== "draft" ||
    !isDeepStrictEqual(receipt.record.content.draft, saved.proposedDraft)
  )
    throw csvApplyUnavailable();
  return receipt;
}

export function applyReceivingCsvPreview(
  db: Db,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
) {
  return receivingTransaction(db, async (tx) => {
    await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.RECEIVING_WRITE);
    const previewId = parseMasterDataInput(platformUuidSchema, id);
    const value = parseMasterDataInput(receivingCsvApplyInputSchema, input);
    const stored = await lockReceivingOperation(tx, tenantId, command, value.operationKey);
    const [row] = await tx
      .select()
      .from(previews)
      .where(and(eq(previews.tenantId, tenantId), eq(previews.id, previewId)))
      .for("update");
    if (!row) throw new NotFoundException({ code: "receiving_csv_preview_not_found" });
    const saved = receivingCsvPreviewResponse(row);
    if (!saved.proposedDraft || !saved.previewDigest)
      throw new ConflictException({ code: "receiving_csv_preview_not_applicable" });
    if (saved.previewDigest !== value.expectedPreviewDigest)
      throw new ConflictException({ code: "receiving_csv_preview_conflict" });
    const applied = await binding(tx, tenantId, previewId);
    if (stored) {
      const result = await replay(tx, tenantId, stored);
      if (
        stored.inputDigest !== saved.previewDigest ||
        (applied && applied.operationKey !== stored.operationKey)
      )
        throw conflict();
      if (!applied)
        await tx.insert(applications).values({
          tenantId,
          previewId,
          command,
          operationKey: result.operationKey,
          inputDigest: result.inputDigest,
        });
      return result;
    }
    if (applied) {
      if (applied.command !== command || applied.inputDigest !== saved.previewDigest)
        throw csvApplyUnavailable();
      const [original] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.tenantId, tenantId),
            eq(operations.command, command),
            eq(operations.operationKey, applied.operationKey),
          ),
        );
      if (!original) throw csvApplyUnavailable();
      return replay(tx, tenantId, original);
    }
    if (row.expiresAt.getTime() <= Date.now())
      throw new ConflictException({ code: "receiving_csv_preview_expired" });
    const prepared = prepareUsReceivingCsvFile({
      templateVersion: row.templateVersion,
      fileBase64: row.fileBytes.toString("base64"),
      header: row.originalHeader,
    });
    const resolution = await resolveReceivingCsvReferences(tx, tenantId, prepared);
    const proposal = buildReceivingCsvProposal(prepared, resolution);
    if (
      !isDeepStrictEqual(resolution, saved.resolution) ||
      !isDeepStrictEqual(proposal.proposedDraft, saved.proposedDraft) ||
      proposal.previewDigest !== saved.previewDigest
    )
      throw new ConflictException({ code: "receiving_csv_preview_stale" });
    const record = await insertReceivingDraft(
      tx,
      tenantId,
      actorUserId,
      saved.proposedDraft,
      requestId,
      "versioned",
    );
    const result = parseReceivingCsvReceipt({
      receiptVersion: 1,
      command,
      operationKey: value.operationKey,
      inputDigest: saved.previewDigest,
      importId: previewId,
      eventId: record.id,
      record,
    });
    await tx.insert(operations).values({
      tenantId,
      command,
      operationKey: value.operationKey,
      inputDigest: saved.previewDigest,
      eventId: record.id,
      result,
    });
    await tx.insert(applications).values({
      tenantId,
      previewId,
      command,
      operationKey: value.operationKey,
      inputDigest: saved.previewDigest,
    });
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "traceability.receiving.csv_applied",
      outcome: "success",
      targetType: "receiving_csv_preview",
      targetId: previewId,
      before: null,
      after: {
        importId: previewId,
        eventId: record.id,
        fileSha256: saved.fileSha256,
        templateVersion: saved.templateVersion,
        rowCount: saved.rowCount,
        inputDigest: saved.previewDigest,
      },
      requestId,
    });
    // Reference/counter/audit locks may have outlived the initial eligibility check.
    // Throwing here rolls back the entire first application, never a successful replay.
    if (row.expiresAt.getTime() <= Date.now())
      throw new ConflictException({ code: "receiving_csv_preview_expired" });
    return result;
  });
}
