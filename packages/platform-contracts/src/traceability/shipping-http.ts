import { z } from "zod";
import { UOM_CODES_V1, isTlcSourceReferenceUrl } from "@markiro/domain";
import { platformUuidSchema } from "../primitives.js";
import { productDescriptionSnapshotSchema } from "./products.js";
import { locationDescriptionSnapshotSchema } from "./receiving-finalization-v1.js";
import { shippingDraftRecordSchema } from "./shipping-records.js";

export const SHIPPING_READINESS_RULE_VERSION = "shipping-readiness-v1" as const;
const version = z.number().int().min(1).max(2147483647);
const quantity = z.string().regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/);
const signedQuantity = z.string().regex(/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/);
export const shippingBalanceQuerySchema = z.union([
  z.object({}).strict(),
  z.object({ contextDraftId: platformUuidSchema, expectedDraftVersion: version }).strict(),
]);
export const shippingBalanceResponseSchema = z
  .object({
    lotId: platformUuidSchema,
    originUom: z.enum(UOM_CODES_V1).nullable(),
    balance: z.discriminatedUnion("state", [
      z
        .object({
          state: z.literal("known"),
          unitOfMeasure: z.enum(UOM_CODES_V1),
          supply: quantity,
          used: quantity,
          remaining: signedQuantity,
        })
        .strict(),
      z
        .object({
          state: z.literal("unknown"),
          reason: z.enum(["no_current_origin", "mixed_uom", "invalid_quantity", "overflow"]),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (value) => value.balance.state !== "known" || value.originUom === value.balance.unitOfMeasure,
  );
export type ShippingBalanceResponse = z.infer<typeof shippingBalanceResponseSchema>;
export const shippingReadinessQuerySchema = z.object({ expectedDraftVersion: version }).strict();
export const shippingIssueSchema = z
  .object({
    severity: z.literal("error"),
    path: z.string().min(1).max(100),
    code: z.string().min(1).max(100),
    line: z.number().int().min(1).max(100).nullable(),
  })
  .strict();
export const shippingReadinessSchema = z
  .object({
    eventId: platformUuidSchema,
    expectedDraftVersion: version,
    ruleVersion: z.literal(SHIPPING_READINESS_RULE_VERSION),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["complete", "incomplete"]),
    profileCode: z.enum(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"]),
    issues: z.array(shippingIssueSchema).max(5000),
  })
  .strict()
  .refine((value) => (value.state === "complete") === (value.issues.length === 0));

export type ShippingReadiness = z.infer<typeof shippingReadinessSchema>;

export const finalizeShippingSchema = z
  .object({
    operationKey: platformUuidSchema,
    expectedDraftVersion: version,
    expectedInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const description = z.string().min(1).max(2000);
const source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("location"), location: locationDescriptionSnapshotSchema }).strict(),
  z
    .object({
      kind: z.literal("reference"),
      referenceKind: z.literal("web_url"),
      referenceValue: z.string().max(1024).refine(isTlcSourceReferenceUrl),
      resolvedLocation: locationDescriptionSnapshotSchema,
    })
    .strict(),
]);
const product = z
  .object({
    id: platformUuidSchema,
    description: productDescriptionSnapshotSchema,
    coverage: z
      .object({
        coverageStatus: z.enum([
          "covered",
          "contains_ftl_same_form",
          "not_covered",
          "unknown",
          "exempt_pending_review",
        ]),
        coverageRationale: z.string().nullable(),
        ftlCategory: z.string().nullable(),
        ftlSourceUrl: z.string().nullable(),
        ftlSourceVersion: z.string().nullable(),
        reviewedBy: z.string().nullable(),
        reviewedAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.id.toLowerCase() === value.description.sourceProductId.toLowerCase(), {
    path: ["description", "sourceProductId"],
    message: "Product identity mismatch",
  });
export const shippingFinalizationSnapshotV1Schema = z
  .object({
    snapshotVersion: z.literal(1),
    eventId: platformUuidSchema,
    eventNumber: shippingDraftRecordSchema.shape.eventNumber,
    revision: version,
    previousRevisionId: platformUuidSchema.optional(),
    eventDate: z.iso.date(),
    timeZone: shippingDraftRecordSchema.shape.timeZone,
    shipFrom: locationDescriptionSnapshotSchema,
    recipient: locationDescriptionSnapshotSchema,
    carrierReference: z.string().nullable(),
    notes: z.string().nullable(),
    items: z
      .array(
        z
          .object({
            lineNo: z.number().int().min(1).max(100),
            lotId: platformUuidSchema,
            quantity: z.string().regex(/^(0|[1-9]\d{0,14})(?:\.\d{1,3})?$/),
            unitOfMeasure: z.enum([
              "lb",
              "oz",
              "kg",
              "g",
              "each",
              "case",
              "bag",
              "cup",
              "gal",
              "l",
            ]),
            tlc: description,
            source,
            product,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    documents: z
      .array(
        z
          .object({
            id: platformUuidSchema,
            type: description,
            number: description,
            issuer: z
              .object({
                id: platformUuidSchema,
                name: description,
                legalName: z.string().nullable(),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    finalizedBy: z.string().min(1).max(128),
    finalizedAt: z.iso.datetime(),
  })
  .strict();

export const shippingFinalizedRecordSchema = shippingDraftRecordSchema
  .omit({ status: true })
  .extend({
    status: z.literal("finalized"),
    snapshot: shippingFinalizationSnapshotV1Schema,
  })
  .strict();
export const shippingHttpRecordSchema = z.union([
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
]);
const blocker = z
  .object({
    lotId: platformUuidSchema,
    eventId: platformUuidSchema,
    rootId: platformUuidSchema,
    revision: version,
  })
  .strict();
export const shippingHttpErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.enum([
        "shipping_not_draft",
        "shipping_draft_conflict",
        "shipping_operation_conflict",
        "shipping_readiness_changed",
        "shipping_lifecycle_conflict",
      ]),
    })
    .strict(),
  z
    .object({ code: z.literal("shipping_pending_amendment"), pendingDraftId: platformUuidSchema })
    .strict(),
  z
    .object({
      code: z.literal("traceability_downstream_blocked"),
      blockers: z.array(blocker).max(100),
      hasMore: z.boolean(),
    })
    .strict(),
  z
    .object({ code: z.literal("event_incomplete"), issues: z.array(shippingIssueSchema).max(5000) })
    .strict(),
]);
export type FinalizeShippingInput = z.infer<typeof finalizeShippingSchema>;
export type ShippingFinalizationSnapshotV1 = z.infer<typeof shippingFinalizationSnapshotV1Schema>;
export type ShippingFinalizedRecord = z.infer<typeof shippingFinalizedRecordSchema>;
