import type { UsPlanConfiguredFacts, UsPlanImpact, UsPlanSnapshot } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { usPlanApproveBodySchema, usPlanSectionsSchema } from "./plans.js";

const positiveRevision = z.number().int().min(1);
const timestamp = z.iso.datetime({ offset: true });
const text = z.string().max(4096);
const nullableText = text.nullable();
const provenance = z.enum(["operational", "trusted_synthetic"]);
const publicationAvailability = z.enum(["available", "artifact_storage_unconfigured"]);
const impactSchema = z
  .object({
    changedSections: z.array(
      z.enum(["tenant", "profile", "tlcSourceLocations", "productProfiles"]),
    ),
    changedLocationIds: z.array(platformUuidSchema),
    changedProductIds: z.array(platformUuidSchema),
  })
  .strict() satisfies z.ZodType<UsPlanImpact>;

export const usPlanValidateBodySchema = z
  .object({
    expectedRevision: positiveRevision,
    confirmations: usPlanApproveBodySchema.shape.confirmations,
  })
  .strict();
export const usPlanPreviewBodySchema = z.object({ expectedRevision: positiveRevision }).strict();
export const usPlanValidationResponseSchema = z
  .object({
    versionId: platformUuidSchema,
    draftRevision: positiveRevision,
    issues: z.array(
      z
        .object({
          section: z.enum([
            "plan",
            "recordMaintenance",
            "ftlIdentification",
            "tlcAssignment",
            "pointOfContact",
            "farmActivity",
            "reviewAndUpdate",
          ]),
          path: z.string(),
          code: z.string(),
        })
        .strict(),
    ),
    publicationAvailability,
  })
  .strict();

const configuredSchema = z
  .object({
    tenantName: text,
    profileCode: z.literal("US_FSMA204_PROCESSOR"),
    baselineVersion: text,
    timeZone: text,
    retentionYears: z.number().int().min(2),
    tlcSourceLocations: z
      .array(
        z
          .object({
            id: platformUuidSchema,
            description: z
              .object({
                partyId: platformUuidSchema,
                businessName: text,
                phoneNumber: nullableText,
                addressKind: z.enum(["street", "coordinates"]),
                streetAddress: nullableText,
                latitude: nullableText,
                longitude: nullableText,
                city: nullableText,
                stateOrRegion: nullableText,
                zipOrPostalCode: nullableText,
                countryCode: nullableText,
              })
              .strict(),
          })
          .strict(),
      )
      .max(200),
    productProfiles: z
      .array(
        z
          .object({
            productId: platformUuidSchema,
            revision: positiveRevision,
            coverageStatus: text,
          })
          .strict(),
      )
      .max(200),
  })
  .strict() satisfies z.ZodType<UsPlanConfiguredFacts>;
const coverageStatus = z.enum([
  "covered",
  "contains_ftl_same_form",
  "not_covered",
  "unknown",
  "exemption_review_required",
]);
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    configured: configuredSchema,
    sections: usPlanSectionsSchema,
    provenance,
    ftlReviewWorkflow: z
      .object({
        version: positiveRevision,
        reviewMode: z.literal("manual"),
        coverageStatuses: z.array(coverageStatus),
        positiveCoverageStatuses: z.array(coverageStatus),
        positiveCoverageEvidenceFields: z.array(
          z.enum([
            "coverageStatus",
            "coverageRationale",
            "ftlCategory",
            "ftlSourceUrl",
            "ftlSourceVersion",
            "reviewedBy",
            "reviewedAt",
          ]),
        ),
        coverageChangeAuthority: z.literal("traceability.qa.manage"),
        reviewerAttribution: z.literal("server_actor_on_coverage_change"),
        reviewTimeAttribution: z.literal("server_time_on_coverage_change"),
        reviewCadenceSource: z.literal("operator_narrative"),
        automaticLegalDetermination: z.literal(false),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<UsPlanSnapshot>;
const confirmationSource = z.discriminatedUnion("origin", [
  z
    .object({
      origin: z.literal("operator_confirmed"),
      actorId: platformUuidSchema,
      confirmedAt: timestamp,
    })
    .strict(),
  z.object({ origin: z.literal("synthetic_fixture") }).strict(),
]);
const sourceSchema = z.union([
  confirmationSource,
  z.object({ origin: z.literal("configured") }).strict(),
  z.object({ origin: z.literal("application_policy"), version: positiveRevision }).strict(),
  z.object({ origin: z.literal("operator_pending") }).strict(),
]);
const factSourcesSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(z.object({ path: z.string(), source: sourceSchema }).strict()),
  })
  .strict();
const artifactSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().min(1).max(8_000_000),
    rendererVersion: z.string().min(1).max(128),
  })
  .strict();
const common = {
  id: platformUuidSchema,
  versionNumber: positiveRevision,
  createdAt: timestamp,
  updatedAt: timestamp,
  provenance,
};
const draftItem = z
  .object({ ...common, status: z.literal("draft"), draftRevision: positiveRevision })
  .strict();
const publishedItem = z
  .object({
    ...common,
    status: z.enum(["effective", "superseded"]),
    approvedAt: timestamp,
    supersededAt: timestamp.nullable(),
    retainThrough: z.iso.date().nullable(),
    artifact: artifactSchema,
  })
  .strict();
export const usPlanListResponseSchema = z
  .object({
    items: z.array(z.discriminatedUnion("status", [draftItem, publishedItem])),
    effectiveImpact: impactSchema.nullable(),
    publicationAvailability,
  })
  .strict();
export const usPlanDetailResponseSchema = z.discriminatedUnion("status", [
  draftItem
    .extend({
      schemaVersion: z.literal(1),
      sections: usPlanSectionsSchema,
      changeSummary: text,
      createdBy: platformUuidSchema,
      statementOwnership: z.literal("operator_pending"),
    })
    .strict(),
  publishedItem
    .extend({
      schemaVersion: z.literal(1),
      createdBy: platformUuidSchema,
      approvedBy: platformUuidSchema,
      changeSummary: text,
      snapshot: snapshotSchema,
      factSources: factSourcesSchema,
      confirmations: z
        .object({
          procedures: confirmationSource,
          backupAndRecovery: confirmationSource,
          contact: confirmationSource,
          nonFarmScope: confirmationSource,
        })
        .strict(),
      comparisonAgainstCurrentConfiguredFacts: impactSchema,
      retentionIndefiniteReason: z.enum(["hold", "date_range_exceeded"]).nullable(),
    })
    .strict(),
]);
export type UsPlanListResponse = z.infer<typeof usPlanListResponseSchema>;
export type UsPlanDetailResponse = z.infer<typeof usPlanDetailResponseSchema>;
export type UsPlanValidationResponse = z.infer<typeof usPlanValidationResponseSchema>;

/** Acknowledges the committed command without a second, potentially racing read. */
export const usPlanDraftCommandResponseSchema = z
  .object({
    id: platformUuidSchema,
    versionNumber: positiveRevision,
    status: z.literal("draft"),
    draftRevision: positiveRevision,
    schemaVersion: z.literal(1),
    sections: usPlanSectionsSchema,
    changeSummary: text,
    createdBy: platformUuidSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    statementOwnership: z.literal("operator_pending"),
  })
  .strict();
export const usPlanApprovalResponseSchema = z
  .object({
    id: platformUuidSchema,
    versionNumber: positiveRevision,
    status: z.literal("effective"),
    approvedAt: timestamp,
    sha256: artifactSchema.shape.sha256,
  })
  .strict();
