import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ServiceUnavailableException } from "@nestjs/common";
import type { schema } from "@markiro/db";
import {
  receivingCsvResolutionSchema,
  receivingDraftSchema,
  type ReceivingDraftItem,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { prepareUsReceivingCsvFile, type PreparedReceivingCsvFile } from "./us-receiving-csv-input";

export {
  receivingCsvResolutionSchema,
  type ReceivingCsvResolution,
} from "@markiro/platform-contracts";
const findingsSchema = z
  .object({
    version: z.literal(1),
    content: z.unknown(),
    resolution: receivingCsvResolutionSchema,
  })
  .strict();
export const csvPreviewUnavailable = () =>
  new ServiceUnavailableException({ code: "receiving_csv_preview_unavailable" });

/** Stable schema order, not raw object order. This digest is content identity, not permission. */
export function buildReceivingCsvProposal(prepared: PreparedReceivingCsvFile, input: unknown) {
  const parsed = receivingCsvResolutionSchema.safeParse(input);
  if (!parsed.success) throw csvPreviewUnavailable();
  const resolution = parsed.data;
  const rows = prepared.content.ok ? prepared.content.rows : [];
  if (resolution.rows.length !== rows.length) throw csvPreviewUnavailable();
  const headerKeys = new Set<string>();
  for (const issue of resolution.headerIssues) {
    const key = `${issue.field}:${issue.documentIndex ?? ""}`;
    const exists =
      issue.field === "documentIds"
        ? issue.documentIndex !== null &&
          prepared.input.header.documentIds[issue.documentIndex] !== undefined
        : prepared.input.header[issue.field] !== null;
    if (!exists || headerKeys.has(key)) throw csvPreviewUnavailable();
    headerKeys.add(key);
  }
  const items: ReceivingDraftItem[] = [];
  let blocked = !prepared.content.ok || resolution.headerIssues.length > 0;
  for (const [index, row] of rows.entries()) {
    const resolved = resolution.rows[index];
    if (!resolved || resolved.rowNumber !== row.rowNumber) throw csvPreviewUnavailable();
    if (!row.validation.ok) {
      if (resolved.productId !== null || resolved.issues.length) throw csvPreviewUnavailable();
      blocked = true;
      continue;
    }
    const selector = row.validation.productSelector;
    const allowed = new Set<string>([selector.kind === "id" ? "product_id" : "product_gtin"]);
    if (row.validation.item.lotId !== null) allowed.add("lot_id");
    if (row.validation.item.source)
      allowed.add(
        row.validation.item.source.kind === "location"
          ? "source_location_id"
          : "source_resolved_location_id",
      );
    const columns = new Set<string>();
    for (const issue of resolved.issues) {
      if (!allowed.has(issue.column) || columns.has(issue.column)) throw csvPreviewUnavailable();
      columns.add(issue.column);
    }
    const productIssue = resolved.issues.some(
      (issue) => issue.column === (selector.kind === "id" ? "product_id" : "product_gtin"),
    );
    if (
      (resolved.productId === null) !== productIssue ||
      (resolved.productId !== null &&
        selector.kind === "id" &&
        resolved.productId !== selector.value)
    )
      throw csvPreviewUnavailable();
    if (resolved.issues.length) blocked = true;
    items.push({ ...row.validation.item, productId: resolved.productId });
  }
  if (blocked) return { proposedDraft: null, previewDigest: null };
  const draft = receivingDraftSchema.safeParse({ ...prepared.input.header, items });
  if (!draft.success || !draft.data.items.length) throw csvPreviewUnavailable();
  const proposedDraft = draft.data;
  const previewDigest = createHash("sha256")
    .update(
      JSON.stringify({
        templateVersion: prepared.input.templateVersion,
        fileSha256: prepared.fileSha256,
        header: prepared.input.header,
        draft: proposedDraft,
      }),
    )
    .digest("hex");
  return { proposedDraft, previewDigest };
}

/** Reopen saved evidence, never resolve it against today's catalog or silently repair it. */
export function receivingCsvPreviewResponse(row: typeof schema.receivingCsvPreviews.$inferSelect) {
  try {
    const prepared = prepareUsReceivingCsvFile({
      templateVersion: row.templateVersion,
      fileBase64: row.fileBytes.toString("base64"),
      header: row.originalHeader,
      ...(row.fileName === null ? {} : { fileName: row.fileName }),
    });
    const findings = findingsSchema.safeParse(row.findings);
    if (
      !findings.success ||
      !isDeepStrictEqual(findings.data, row.findings) ||
      !isDeepStrictEqual(findings.data.content, prepared.content)
    )
      throw csvPreviewUnavailable();
    const proposal = buildReceivingCsvProposal(prepared, findings.data.resolution);
    const rowCount = prepared.content.ok ? prepared.content.rows.length : 0;
    if (
      row.byteSize !== prepared.byteSize ||
      row.fileSha256 !== prepared.fileSha256 ||
      row.rowCount !== rowCount ||
      row.previewDigest !== proposal.previewDigest ||
      !isDeepStrictEqual(row.proposedDraft, proposal.proposedDraft) ||
      row.expiresAt.getTime() - row.createdAt.getTime() !== 86400000
    )
      throw csvPreviewUnavailable();
    return {
      id: row.id,
      templateVersion: prepared.input.templateVersion,
      fileName: row.fileName,
      byteSize: row.byteSize,
      fileSha256: row.fileSha256,
      rowCount,
      originalHeader: row.originalHeader,
      header: prepared.input.header,
      content: prepared.content,
      resolution: findings.data.resolution,
      ...proposal,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  } catch {
    // Do not expose raw persisted input, Zod details or decoder errors through corruption paths.
    throw csvPreviewUnavailable();
  }
}
