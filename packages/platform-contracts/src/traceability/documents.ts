import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema } from "./event-values.js";
import { listUsPartiesQuerySchema } from "./master-data.js";

export const referenceDocumentTypeSchema = z.enum([
  "bol",
  "po",
  "asn",
  "work_order",
  "invoice",
  "database_record",
  "batch_log",
  "production_log",
  "other",
]);

const identifier = z
  .string()
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value), "Invalid document text");
const inputText = (maximum: number) => identifier.trim().min(1).max(maximum);
const pinnedText = (maximum: number) =>
  identifier.max(maximum).refine((value) => value.trim().length > 0, "Required document text");
const databaseText = z
  .string()
  .refine((value) => !value.includes("\u0000") && !/\p{Cs}/u.test(value), "Invalid document text");

function otherTypeIssue(
  value: { type: z.infer<typeof referenceDocumentTypeSchema>; typeOtherLabel: string | null },
  context: z.RefinementCtx,
) {
  if ((value.type === "other") !== (value.typeOtherLabel !== null))
    context.addIssue({
      code: "custom",
      path: ["typeOtherLabel"],
      message: "A custom type label is required only for other documents",
    });
}

/** Metadata only. Tenant scope, permissions, revision checks and frozen links belong to the store. */
export const referenceDocumentInputSchema = z
  .object({
    type: referenceDocumentTypeSchema,
    typeOtherLabel: inputText(200).nullable(),
    number: inputText(128),
    partyId: platformUuidSchema.nullable(),
    issuedOn: traceabilityCivilDateSchema.nullable(),
    notes: databaseText.trim().min(1).max(2000).nullable(),
  })
  .strict()
  .superRefine(otherTypeIssue);

/** No transforms: a persisted snapshot read cannot repair or rewrite its identifiers. */
export const referenceDocumentSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(1),
    documentId: z.uuid(),
    type: referenceDocumentTypeSchema,
    typeOtherLabel: pinnedText(200).nullable(),
    number: pinnedText(128),
    partyId: z.uuid().nullable(),
    issuedOn: traceabilityCivilDateSchema.nullable(),
    notes: databaseText
      .max(2000)
      .refine((value) => value.trim().length > 0)
      .nullable(),
  })
  .strict()
  .superRefine(otherTypeIssue);

export type ReferenceDocumentType = z.infer<typeof referenceDocumentTypeSchema>;
export type ReferenceDocumentInput = z.infer<typeof referenceDocumentInputSchema>;
export type ReferenceDocumentSnapshot = z.infer<typeof referenceDocumentSnapshotSchema>;

const pinned = referenceDocumentSnapshotSchema.shape;
export const referenceDocumentSchema = z
  .object({
    id: z.uuid(),
    type: pinned.type,
    typeOtherLabel: pinned.typeOtherLabel,
    number: pinned.number,
    partyId: pinned.partyId,
    issuedOn: pinned.issuedOn,
    notes: pinned.notes,
    archivedAt: z.iso.datetime({ offset: true }).nullable(),
    createdBy: z.string().min(1).max(128),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine(otherTypeIssue);

export const listReferenceDocumentsQuerySchema = listUsPartiesQuerySchema
  .extend({
    search: databaseText.trim().max(200).optional(),
    type: referenceDocumentTypeSchema.optional(),
    partyId: platformUuidSchema.optional(),
  })
  .strict();

export const referenceDocumentListSchema = z
  .object({
    items: z.array(referenceDocumentSchema).max(100),
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

export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;
export type ReferenceDocumentList = z.infer<typeof referenceDocumentListSchema>;
