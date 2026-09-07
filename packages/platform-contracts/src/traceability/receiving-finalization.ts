import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import {
  listReceivingDraftsQuerySchema,
  receivingDraftRecordSchema,
  receivingDraftSummarySchema,
} from "./receiving-records.js";
import { receivingFinalizationSnapshotV1Schema } from "./receiving-finalization-v1.js";
import { receivingFinalizationSnapshotV2Schema } from "./receiving-finalization-v2.js";

export const receivingFinalizationSnapshotSchema = z.discriminatedUnion("snapshotVersion", [
  receivingFinalizationSnapshotV1Schema,
  receivingFinalizationSnapshotV2Schema,
]);
const databaseVersion = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z
  .string()
  .max(128)
  .refine(
    (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
  );

export const finalizeReceivingSchema = z
  .object({
    operationKey: platformUuidSchema,
    expectedDraftVersion: databaseVersion,
    expectedInputDigest: digest,
    reviewedExemptLines:
      receivingFinalizationSnapshotV2Schema.shape.confirmation.shape.reviewedExemptLines.optional(),
  })
  .strict();

const draftRecord = receivingDraftRecordSchema.shape;
export const receivingFinalizedRecordSchema = z
  .object({
    id: draftRecord.id,
    eventNumber: draftRecord.eventNumber,
    status: z.literal("finalized"),
    revision: z.literal(1),
    draftVersion: databaseVersion,
    timeZone: draftRecord.timeZone,
    createdBy: draftRecord.createdBy,
    updatedBy: draftRecord.updatedBy,
    createdAt: draftRecord.createdAt,
    updatedAt: draftRecord.updatedAt,
    finalizedAt: z.iso.datetime(),
    finalizedBy: actor,
    snapshot: receivingFinalizationSnapshotSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt !== value.finalizedAt)
      context.addIssue({
        code: "custom",
        path: ["finalizedAt"],
        message: "Finalization timestamp must match the record update",
      });
    if (value.updatedBy !== value.finalizedBy)
      context.addIssue({
        code: "custom",
        path: ["finalizedBy"],
        message: "Finalization actor must match the record update",
      });
    if (value.snapshot.snapshotVersion === 2)
      value.snapshot.items.forEach((item, index) => {
        if (item.receiptBasis.kind === "ordinary") return;
        if (
          item.receiptBasis.reviewedBy !== value.finalizedBy ||
          item.receiptBasis.reviewedAt !== value.finalizedAt
        )
          context.addIssue({
            code: "custom",
            path: ["snapshot", "items", index, "receiptBasis"],
            message: "Receipt review must match the finalization actor and timestamp",
          });
      });
  });

export const receivingRecordSchema = z.discriminatedUnion("status", [
  receivingDraftRecordSchema,
  receivingFinalizedRecordSchema,
]);

export const listReceivingRecordsQuerySchema = listReceivingDraftsQuerySchema.safeExtend({
  status: z.enum(["draft", "finalized"]).optional(),
});

const draftSummary = receivingDraftSummarySchema.shape;
export const receivingRecordSummarySchema = z
  .object({ ...draftSummary, status: z.enum(["draft", "finalized"]) })
  .strict();

export const receivingRecordListSchema = z
  .object({
    items: z.array(receivingRecordSummarySchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(100000),
  })
  .strict()
  .refine((value) => value.items.length <= value.limit, "Item count exceeds response limit");

export type FinalizeReceivingInput = z.infer<typeof finalizeReceivingSchema>;
export type ReceivingFinalizationSnapshot = z.infer<typeof receivingFinalizationSnapshotSchema>;
export type ReceivingFinalizedRecord = z.infer<typeof receivingFinalizedRecordSchema>;
export type ReceivingRecord = z.infer<typeof receivingRecordSchema>;
export type ListReceivingRecordsQuery = z.infer<typeof listReceivingRecordsQuerySchema>;
export type ReceivingRecordSummary = z.infer<typeof receivingRecordSummarySchema>;
export type ReceivingRecordList = z.infer<typeof receivingRecordListSchema>;
