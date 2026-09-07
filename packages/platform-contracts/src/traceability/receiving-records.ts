import { isTlcSourceReferenceUrl } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityQuantitySchema } from "./event-values.js";
import { preservedTlcSchema } from "./lots.js";
import { listUsPartiesQuerySchema } from "./master-data.js";
import { provisionUsTraceabilityProfileSchema } from "./profile.js";
import { receivingDraftItemSchema, receivingDraftSchema } from "./receiving.js";
import { preservedReceivingExemptReceiptSchema } from "./receiving-exemption.js";

export const createReceivingDraftSchema = z
  .object({
    operationKey: platformUuidSchema,
    draft: receivingDraftSchema,
  })
  .strict();

export const saveReceivingDraftSchema = createReceivingDraftSchema
  .extend({
    expectedDraftVersion: z.number().int().min(1).max(2147483646),
  })
  .strict();

const pinnedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
    )
    .nullable();
const pinnedSource = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("location"), locationId: z.uuid() }).strict(),
    z
      .object({
        kind: z.literal("reference"),
        referenceKind: z.literal("web_url"),
        referenceValue: z.string().max(1024).refine(isTlcSourceReferenceUrl),
        resolvedLocationId: z.uuid(),
      })
      .strict(),
  ])
  .nullable();
const pinnedItem = receivingDraftItemSchema.extend({
  productId: z.uuid().nullable(),
  lotId: z.uuid().nullable(),
  tlc: preservedTlcSchema.nullable(),
  source: pinnedSource,
  quantity: z
    .string()
    .refine((value) => {
      const result = traceabilityQuantitySchema.safeParse(value);
      return result.success && result.data === value;
    })
    .nullable(),
  exemptReason: pinnedText(2000),
  exemptReceipt: preservedReceivingExemptReceiptSchema.nullable().optional(),
  supplierLotReference: pinnedText(128),
  notes: pinnedText(2000),
});

/** No transforms: reading saved state must not silently repair it. */
export const receivingDraftRecordSchema = z
  .object({
    id: z.uuid(),
    eventNumber: z.string().regex(/^REC-\d{2}-\d{4,10}$/),
    status: z.literal("draft"),
    revision: z.literal(1),
    draftVersion: z.number().int().min(1).max(2147483647),
    timeZone: provisionUsTraceabilityProfileSchema.shape.timeZone,
    createdBy: z.string().min(1).max(128),
    updatedBy: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    draft: receivingDraftSchema.extend({
      locationId: z.uuid().nullable(),
      previousSourceLocationId: z.uuid().nullable(),
      receivedAtNote: pinnedText(2000),
      notes: pinnedText(2000),
      items: z.array(pinnedItem).max(100),
      documentIds: z
        .array(z.uuid())
        .max(100)
        .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length),
    }),
  })
  .strict();

const databaseText = z
  .string()
  .refine(
    (value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value),
    "Invalid receiving search text",
  );

export const listReceivingDraftsQuerySchema = listUsPartiesQuerySchema
  .pick({ limit: true, offset: true })
  .extend({ search: databaseText.trim().max(200).optional() })
  .strict();

const record = receivingDraftRecordSchema.shape;
const savedDraft = record.draft.shape;
export const receivingDraftSummarySchema = z
  .object({
    id: record.id,
    eventNumber: record.eventNumber,
    status: record.status,
    revision: record.revision,
    draftVersion: record.draftVersion,
    timeZone: record.timeZone,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dateReceived: savedDraft.dateReceived,
    locationId: savedDraft.locationId,
    previousSourceLocationId: savedDraft.previousSourceLocationId,
    lineCount: z.number().int().min(0).max(100),
    documentCount: z.number().int().min(0).max(100),
  })
  .strict();

export const receivingDraftListSchema = z
  .object({
    items: z.array(receivingDraftSummarySchema).max(100),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(100000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit)
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item count exceeds response limit",
      });
  });

export type ReceivingDraftRecord = z.infer<typeof receivingDraftRecordSchema>;
export type ReceivingDraftSummary = z.infer<typeof receivingDraftSummarySchema>;
export type ReceivingDraftList = z.infer<typeof receivingDraftListSchema>;
export type ListReceivingDraftsQuery = z.infer<typeof listReceivingDraftsQuerySchema>;
export type CreateReceivingDraftInput = z.infer<typeof createReceivingDraftSchema>;
export type SaveReceivingDraftInput = z.infer<typeof saveReceivingDraftSchema>;
