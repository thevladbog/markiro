import { RECEIVING_CSV_COLUMNS, RECEIVING_CSV_VERSION } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { receivingDraftRecordSchema } from "./receiving-records.js";
import { receivingLiveRecordSchema } from "./receiving-live-records.js";
import { parseReceivingCsvRow } from "./receiving-csv.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const issueCode = z.enum(["not_found", "inactive"]);
export const receivingCsvResolutionSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            rowNumber: z.number().int().min(1).max(100),
            productId: platformUuidSchema.nullable(),
            issues: z
              .array(
                z
                  .object({
                    column: z.enum([
                      "product_id",
                      "product_gtin",
                      "lot_id",
                      "source_location_id",
                      "source_resolved_location_id",
                    ]),
                    code: issueCode,
                  })
                  .strict(),
              )
              .max(3),
          })
          .strict(),
      )
      .max(100),
    headerIssues: z
      .array(
        z
          .object({
            field: z.enum(["locationId", "previousSourceLocationId", "documentIds"]),
            documentIndex: z.number().int().min(0).max(99).nullable(),
            code: issueCode,
          })
          .strict()
          .refine((issue) => (issue.field === "documentIds") === (issue.documentIndex !== null)),
      )
      .max(102),
  })
  .strict();

/** The first committed outcome, never the current state of the event. */
export const receivingCsvReceiptSchema = z
  .object({
    receiptVersion: z.literal(1),
    command: z.literal("receiving.csv.apply"),
    operationKey: z.uuid(),
    inputDigest: digest,
    importId: z.uuid(),
    eventId: z.uuid(),
    record: receivingLiveRecordSchema,
  })
  .strict()
  .refine(
    ({ eventId, record }) =>
      eventId === record.id &&
      record.status === "draft" &&
      record.revision === 1 &&
      record.draftVersion === 1 &&
      record.lifecycle.lifecycleVersion === 1 &&
      record.content.kind === "draft" &&
      record.content.draft.items.length > 0 &&
      record.createdBy === record.updatedBy &&
      record.createdAt === record.updatedAt,
  );

const requestSchema = z
  .object({
    importId: z.uuid(),
    operationKey: z.uuid(),
    expectedPreviewDigest: digest,
  })
  .strict();
export const receivingCsvApplyResponseSchema = z
  .object({
    responseVersion: z.literal(1),
    request: requestSchema,
    receipt: receivingCsvReceiptSchema,
  })
  .strict()
  .refine((value) => value.request.expectedPreviewDigest === value.receipt.inputDigest);

/** Match a captured request before following receipt.eventId with a live GET. */
export function matchesReceivingCsvApplyResponse(value: unknown, expected: unknown): boolean {
  const response = receivingCsvApplyResponseSchema.safeParse(value);
  const request = requestSchema.safeParse(expected);
  return (
    response.success &&
    request.success &&
    response.data.request.importId.toLowerCase() === request.data.importId.toLowerCase() &&
    response.data.request.operationKey.toLowerCase() === request.data.operationKey.toLowerCase() &&
    response.data.request.expectedPreviewDigest === request.data.expectedPreviewDigest
  );
}

const cell = z.string().max(262144);
const savedDraft = receivingDraftRecordSchema.shape.draft;
export const receivingCsvPreviewSchema = z
  .object({
    responseVersion: z.literal(1),
    id: z.uuid(),
    templateVersion: z.literal(RECEIVING_CSV_VERSION),
    fileName: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value))
      .nullable(),
    byteSize: z.number().int().min(0).max(262144),
    fileSha256: digest,
    rowCount: z.number().int().min(0).max(100),
    header: savedDraft.omit({ items: true }),
    fileError: z
      .object({
        code: z.enum([
          "version",
          "byte_limit",
          "invalid_utf8",
          "nul",
          "syntax",
          "header",
          "no_rows",
          "row_limit",
        ]),
        lineNumber: z.number().int().min(1).max(262145),
      })
      .strict()
      .nullable(),
    rows: z
      .array(
        z
          .object({
            rowNumber: z.number().int().min(1).max(100),
            lineNumber: z.number().int().min(2).max(262145),
            cells: z.array(cell).max(262145),
            issues: z
              .array(
                z
                  .object({
                    column: z.enum(RECEIVING_CSV_COLUMNS).nullable(),
                    code: z.enum([
                      "column_count",
                      "value",
                      "product_selector",
                      "boolean",
                      "lot_link",
                      "source",
                    ]),
                  })
                  .strict(),
              )
              .max(100),
            normalizations: z
              .array(
                z
                  .object({ column: z.enum(RECEIVING_CSV_COLUMNS), before: cell, after: cell })
                  .strict(),
              )
              .max(18),
          })
          .strict(),
      )
      .max(100),
    resolution: receivingCsvResolutionSchema,
    proposedDraft: savedDraft.nullable(),
    previewDigest: digest.nullable(),
    createdBy: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "Inconsistent saved CSV preview" });
    if (
      Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== 86400000 ||
      value.rowCount !== value.rows.length ||
      value.rows.length !== value.resolution.rows.length ||
      (value.proposedDraft === null) !== (value.previewDigest === null) ||
      (value.fileError !== null && value.rows.length !== 0) ||
      (value.fileError === null && value.rows.length === 0)
    )
      fail();
    let blocked = value.fileError !== null || value.resolution.headerIssues.length > 0;
    const items = [];
    let previousLine = 1;
    for (const [index, row] of value.rows.entries()) {
      const parsed = parseReceivingCsvRow(row.cells);
      const resolved = value.resolution.rows[index];
      if (
        row.rowNumber !== index + 1 ||
        row.lineNumber <= previousLine ||
        resolved?.rowNumber !== row.rowNumber
      )
        fail();
      previousLine = row.lineNumber;
      if (
        JSON.stringify(row.issues) !== JSON.stringify(parsed.ok ? [] : parsed.issues) ||
        JSON.stringify(row.normalizations) !==
          JSON.stringify(parsed.ok ? parsed.normalizations : [])
      )
        fail();
      if (!parsed.ok || !resolved || resolved.productId === null || resolved.issues.length > 0)
        blocked = true;
      if (parsed.ok && resolved) {
        if (
          resolved.productId !== null &&
          parsed.productSelector.kind === "id" &&
          resolved.productId !== parsed.productSelector.value
        )
          fail();
        items.push({ ...parsed.item, productId: resolved.productId });
      }
    }
    if (blocked !== (value.proposedDraft === null)) fail();
    if (value.proposedDraft !== null) {
      const proposed = savedDraft.safeParse({ ...value.header, items });
      if (
        !proposed.success ||
        JSON.stringify(proposed.data) !== JSON.stringify(value.proposedDraft)
      )
        fail();
    }
  });

export type ReceivingCsvResolution = z.infer<typeof receivingCsvResolutionSchema>;
export type ReceivingCsvReceipt = z.infer<typeof receivingCsvReceiptSchema>;
export type ReceivingCsvApplyResponse = z.infer<typeof receivingCsvApplyResponseSchema>;
export type ReceivingCsvPreview = z.infer<typeof receivingCsvPreviewSchema>;
