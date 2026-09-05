import {
  COVERAGE_STATUSES,
  UOM_CODES_V1,
  validateCoverageReview,
  validateProductDescription,
  type CoverageReviewInput,
  type ProductDescriptionInput,
} from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { usProductSchema } from "./catalog.js";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const unit = z.enum(UOM_CODES_V1);
const descriptionFields = {
  productName: text(200),
  brandName: text(200).nullable(),
  commodity: text(200).nullable(),
  variety: text(200).nullable(),
  packagingSizeValue: z.string().max(13).nullable(),
  packagingSizeUom: unit.nullable(),
  packagingStyle: text(200).nullable(),
  defaultQuantityUom: unit.nullable(),
};
const reviewFields = {
  coverageStatus: z.enum(COVERAGE_STATUSES),
  coverageRationale: text(2000).nullable(),
  ftlCategory: text(200).nullable(),
  ftlSourceUrl: z.string().max(2048).nullable(),
  ftlSourceVersion: text(128).nullable(),
};

function editableIssues(
  value: ProductDescriptionInput & CoverageReviewInput,
  context: z.RefinementCtx,
) {
  // Validates the editable document, not the tenant's actual profile or authority.
  // A consumer MUST run validateCoverageReview again with trusted profile context.
  for (const issue of [
    ...validateProductDescription(value),
    ...validateCoverageReview(value, "US_FSMA204_PROCESSOR"),
  ])
    context.addIssue({ code: "custom", path: [issue.field], message: issue.code });
}

/** Full editable document only; no client-supplied tenancy, identity or review stamps. */
export const upsertProductTraceabilityProfileSchema = z
  .object({ ...descriptionFields, ...reviewFields })
  .strict()
  .superRefine(editableIssues);

/** Zero means an unsaved profile; the server owns and increments the persisted revision. */
export const putProductTraceabilityProfileSchema =
  upsertProductTraceabilityProfileSchema.safeExtend({
    expectedRevision: z.number().int().min(0).max(2147483646),
  });

const timestamp = z.iso.datetime({ offset: true }).nullable();
export const productTraceabilityProfileSchema = z
  .object({
    productId: platformUuidSchema,
    revision: z.number().int().min(0).max(2147483647),
    ...descriptionFields,
    ...reviewFields,
    reviewedBy: z
      .string()
      .max(128)
      .refine((value) => value.trim().length > 0)
      .nullable(),
    reviewedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    editableIssues(value, context);
    if ((value.revision === 0) !== (value.createdAt === null))
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Revision must match persistence state",
      });
    if ((value.createdAt === null) !== (value.updatedAt === null))
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Expected paired persistence timestamps",
      });
    if ((value.reviewedBy === null) !== (value.reviewedAt === null))
      context.addIssue({
        code: "custom",
        path: ["reviewedAt"],
        message: "Expected paired review metadata",
      });
    if (value.coverageStatus !== "unknown" && value.reviewedBy === null)
      context.addIssue({
        code: "custom",
        path: ["reviewedBy"],
        message: "Review metadata required",
      });
    if (value.reviewedBy !== null && value.createdAt === null)
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "A review must be persisted",
      });
  });

// Pinned descriptions are validated without transformations: reading a snapshot cannot rewrite it.
const pinnedText = z
  .string()
  .max(200)
  .refine((value) => value.trim().length > 0);
export const productDescriptionSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(1),
    sourceProductId: platformUuidSchema,
    productName: pinnedText,
    brandName: pinnedText.nullable(),
    commodity: pinnedText.nullable(),
    variety: pinnedText.nullable(),
    packagingSize: z
      .object({ value: z.string().max(13), uom: unit })
      .strict()
      .nullable(),
    packagingStyle: pinnedText.nullable(),
    gtin: usProductSchema.shape.gtin14,
  })
  .strict()
  .superRefine((value, context) => {
    for (const issue of validateProductDescription({
      ...value,
      packagingSizeValue: value.packagingSize?.value ?? null,
      packagingSizeUom: value.packagingSize?.uom ?? null,
      defaultQuantityUom: null,
    })) {
      const path =
        issue.field === "packagingSizeValue"
          ? ["packagingSize", "value"]
          : issue.field === "packagingSizeUom"
            ? ["packagingSize", "uom"]
            : [issue.field];
      context.addIssue({ code: "custom", path, message: issue.code });
    }
  });

export type UpsertProductTraceabilityProfile = z.infer<
  typeof upsertProductTraceabilityProfileSchema
>;
export type ProductTraceabilityProfile = z.infer<typeof productTraceabilityProfileSchema>;
export type PutProductTraceabilityProfile = z.infer<typeof putProductTraceabilityProfileSchema>;
