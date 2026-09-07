import {
  assessCoverageReview,
  COVERAGE_STATUSES,
  isTlcSourceReferenceUrl,
  UOM_CODES_V1,
} from "@markiro/domain";
import { z } from "zod";
import { referenceDocumentSnapshotSchema } from "./documents.js";
import { traceabilityCivilDateSchema, traceabilityQuantitySchema } from "./event-values.js";
import { preservedTlcSchema } from "./lots.js";
import { productDescriptionSnapshotSchema } from "./products.js";
import { usTraceabilityProfileCodeSchema } from "./profile.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const losslessUuid = z.uuid();
const preservedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
    );
const actor = preservedText(128);
const nullableText = (maximum: number) => preservedText(maximum).nullable();
const sameUuid = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const phone = preservedText(40).refine(
  (value) =>
    value.length >= 3 &&
    /\d/.test(value) &&
    /^[\d\s+().,-]*(?:(?:x|ext)[\d\s+().,-]*)?$/i.test(value),
  "Invalid frozen phone number",
);
const coordinate = (minimum: number, maximum: number) =>
  preservedText(32).refine((value) => {
    if (!/^-?\d+(?:\.\d{1,6})?$/.test(value)) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum;
  }, "Invalid frozen coordinate");
const receivingFinalizationSnapshotV1RuleVersionSchema = z.literal("receiving-readiness-v2");

const locationDescriptionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    locationId: losslessUuid,
    partyId: losslessUuid,
    businessName: preservedText(200),
    phoneNumber: phone,
    address: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("street"), streetAddress: preservedText(500) }).strict(),
      z
        .object({
          kind: z.literal("coordinates"),
          latitude: coordinate(-90, 90),
          longitude: coordinate(-180, 180),
        })
        .strict(),
    ]),
    city: preservedText(200),
    stateOrRegion: preservedText(200),
    zipOrPostalCode: preservedText(32),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    countryDisplay: preservedText(200),
  })
  .strict();

const frozenProductDescriptionSchema = productDescriptionSnapshotSchema.safeExtend({
  sourceProductId: losslessUuid,
});
const frozenDocumentSchema = referenceDocumentSnapshotSchema.safeExtend({
  documentId: losslessUuid,
  partyId: losslessUuid.nullable(),
});
const frozenSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("location"), locationId: losslessUuid }).strict(),
  z
    .object({
      kind: z.literal("reference"),
      referenceKind: z.literal("web_url"),
      referenceValue: z.string().max(1024).refine(isTlcSourceReferenceUrl),
      resolvedLocationId: losslessUuid,
    })
    .strict(),
]);
const frozenCoverageSchema = z
  .object({
    coverageStatus: z.enum(COVERAGE_STATUSES),
    coverageRationale: nullableText(2000),
    ftlCategory: nullableText(200),
    ftlSourceUrl: nullableText(2048),
    ftlSourceVersion: nullableText(128),
    reviewedBy: actor.nullable(),
    reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
const frozenItemSchema = z
  .object({
    lineNo: z.number().int().min(1).max(100),
    productId: losslessUuid,
    lotId: losslessUuid,
    lotLinkMode: z.enum(["create_on_finalize", "link_existing"]),
    tlc: preservedTlcSchema,
    source: frozenSourceSchema,
    quantity: z.string().refine((value) => {
      const parsed = traceabilityQuantitySchema.safeParse(value);
      return parsed.success && parsed.data === value;
    }),
    unitOfMeasure: z.enum(UOM_CODES_V1),
    supplierLotReference: nullableText(128),
    notes: nullableText(2000),
    productDescription: frozenProductDescriptionSchema,
    coverage: frozenCoverageSchema,
    sourceDescription: locationDescriptionSnapshotSchema,
  })
  .strict();
const issuerSchema = z
  .object({ id: losslessUuid, name: preservedText(200), legalName: nullableText(200) })
  .strict();
const frozenDocumentEntrySchema = z
  .object({ document: frozenDocumentSchema, issuer: issuerSchema.nullable() })
  .strict();
// Frozen v1 vocabulary must never inherit a newer readiness contract.
const warningSchema = z
  .object({
    severity: z.literal("warning"),
    group: z.enum(["header", "lines", "documents"]),
    line: z.number().int().min(1).max(100).nullable(),
    field: z.enum([
      "dateReceived",
      "location",
      "previousSource",
      "items",
      "product",
      "coverage",
      "tlc",
      "source",
      "quantity",
      "unitOfMeasure",
      "lot",
      "exemption",
      "documents",
    ]),
    code: z.enum([
      "required",
      "format",
      "unavailable",
      "inactive",
      "incomplete_description",
      "wrong_role",
      "coverage_unresolved",
      "not_assessed",
      "lot_product_mismatch",
      "lot_tlc_mismatch",
      "lot_source_mismatch",
      "lot_link_inconsistent",
      "duplicate_identity",
      "exemption_review_required",
      "tlc_assignment_required",
    ]),
    detail: z
      .enum([
        "businessName",
        "phoneNumber",
        "addressKind",
        "streetAddress",
        "latitude",
        "longitude",
        "city",
        "stateOrRegion",
        "zipOrPostalCode",
        "countryCode",
        "productName",
        "brandName",
        "commodity",
        "variety",
        "packagingSizeValue",
        "packagingSizeUom",
        "packagingStyle",
        "defaultQuantityUom",
        "gtin",
        "coverageStatus",
        "coverageRationale",
        "ftlCategory",
        "ftlSourceUrl",
        "ftlSourceVersion",
        "reviewedBy",
        "reviewedAt",
        "exemptReason",
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (value) => value.group === "lines" || value.line === null,
    "Only line findings have a line number",
  );

export const receivingFinalizationSnapshotV1Schema = z
  .object({
    snapshotVersion: z.literal(1),
    dateReceived: traceabilityCivilDateSchema,
    locationId: losslessUuid,
    previousSourceLocationId: losslessUuid,
    receivedAtNote: nullableText(2000),
    notes: nullableText(2000),
    profileCode: usTraceabilityProfileCodeSchema,
    baselineVersion: preservedText(128),
    locationDescription: locationDescriptionSnapshotSchema,
    previousSourceDescription: locationDescriptionSnapshotSchema,
    items: z.array(frozenItemSchema).min(1).max(100),
    documents: z
      .array(frozenDocumentEntrySchema)
      .max(100)
      .refine(
        (entries) =>
          new Set(entries.map(({ document }) => document.documentId.toLowerCase())).size ===
          entries.length,
        "Duplicate frozen document",
      ),
    confirmation: z
      .object({
        ruleVersion: receivingFinalizationSnapshotV1RuleVersionSchema,
        inputDigest: digest,
        warnings: z.array(warningSchema).max(5000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profileCode === "US_FSMA204_PROCESSOR" && value.documents.length === 0)
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: "The FSMA profile requires a frozen reference document",
      });
    if (!sameUuid(value.locationId, value.locationDescription.locationId))
      context.addIssue({
        code: "custom",
        path: ["locationDescription", "locationId"],
        message: "Receiving location snapshot does not match the saved header",
      });
    if (!sameUuid(value.previousSourceLocationId, value.previousSourceDescription.locationId))
      context.addIssue({
        code: "custom",
        path: ["previousSourceDescription", "locationId"],
        message: "Previous-source snapshot does not match the saved header",
      });
    value.items.forEach((item, index) => {
      if (item.lineNo !== index + 1)
        context.addIssue({
          code: "custom",
          path: ["items", index, "lineNo"],
          message: "Frozen receiving lines must retain one-based order",
        });
      if (!sameUuid(item.productId, item.productDescription.sourceProductId))
        context.addIssue({
          code: "custom",
          path: ["items", index, "productDescription", "sourceProductId"],
          message: "Product description does not match the receiving line",
        });
      const sourceLocationId =
        item.source.kind === "location" ? item.source.locationId : item.source.resolvedLocationId;
      if (!sameUuid(sourceLocationId, item.sourceDescription.locationId))
        context.addIssue({
          code: "custom",
          path: ["items", index, "sourceDescription", "locationId"],
          message: "Source description does not match the receiving line",
        });
      const assessment = assessCoverageReview(item.coverage, value.profileCode);
      const invalidGenericReview =
        value.profileCode === "US_GENERIC_LOT_TRACEABILITY" &&
        (item.coverage.reviewedBy !== null || item.coverage.reviewedAt !== null);
      if (assessment.issues.length > 0 || invalidGenericReview)
        context.addIssue({
          code: "custom",
          path: ["items", index, "coverage"],
          message: "Coverage snapshot is invalid for the pinned profile",
        });
    });
    value.documents.forEach(({ document, issuer }, index) => {
      if (
        (document.partyId === null && issuer !== null) ||
        (document.partyId !== null && (issuer === null || !sameUuid(document.partyId, issuer.id)))
      )
        context.addIssue({
          code: "custom",
          path: ["documents", index, "issuer"],
          message: "Document issuer does not match the frozen document",
        });
    });
  });

export type ReceivingFinalizationSnapshotV1 = z.infer<typeof receivingFinalizationSnapshotV1Schema>;
