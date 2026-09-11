import { z } from "zod";
import { validateCatalogPatchCommercialTerms } from "./catalog-validation.js";

import { platformTimestampSchema, platformUuidSchema } from "./primitives.js";
import { assignableCatalogResponseSchema, assignableCatalogVersionSchema } from "./tenants.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positivePostgresIntegerSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nullablePositiveIntegerSchema = positivePostgresIntegerSchema.nullable();
import {
  catalogCommercialMetadataShape,
  resourceQuotaSchema,
  sellerTaxPolicySchema,
} from "./commercial-terms.js";

export const catalogMachineCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const catalogItemReferenceSchema = z.union([platformUuidSchema, catalogMachineCodeSchema]);
export const catalogVersionIdSchema = platformUuidSchema;

export const planEntitlementsSchema = z
  .object({
    maxLines: resourceQuotaSchema,
    maxStations: resourceQuotaSchema,
    maxKiosks: resourceQuotaSchema,
    maxCabinetUsers: resourceQuotaSchema,
    labelEditorEnabled: z.boolean(),
    publicApiEnabled: z.boolean(),
    palletsEnabled: z.boolean(),
    demoDurationDays: nullablePositiveIntegerSchema,
  })
  .strict();

export const legacyPlanEntitlementsSchema = planEntitlementsSchema
  .extend({
    maxLines: nullablePositiveIntegerSchema,
    maxStations: nullablePositiveIntegerSchema,
    maxKiosks: nullablePositiveIntegerSchema,
    maxCabinetUsers: nullablePositiveIntegerSchema,
  })
  .strict();

export const addonEffectSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.enum(["lines", "stations", "kiosks", "cabinetUsers"]),
      quotaIncrement: positivePostgresIntegerSchema,
    })
    .strict(),
  z
    .object({
      key: z.enum(["labelEditor", "publicApi", "pallets"]),
      featureEnabled: z.literal(true),
    })
    .strict(),
]);

const versionFieldsSchema = z.object({
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  descriptionRu: z.string().trim().max(10_000).nullable().optional(),
  descriptionEn: z.string().trim().max(10_000).nullable().optional(),
  unit: z.string().trim().min(1).max(100),
  unitPrice: z.string().regex(/^\d{1,12}\.\d{2}$/, "Expected a decimal amount"),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  vatIncluded: z.boolean(),
});

const planVersionCreateSchema = versionFieldsSchema
  .extend({
    billingMode: z.literal("recurring"),
    billingPeriod: z.enum(["month", "year"]),
    plan: legacyPlanEntitlementsSchema,
  })
  .strict();

const addonPayloadSchema = z
  .object({ effects: z.array(addonEffectSchema).min(1).max(7) })
  .strict()
  .superRefine((value, context) => {
    const keys = value.effects.map((effect) => effect.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["effects"],
        message: "Effect keys must be unique",
      });
    }
  });

const addonVersionCreateSchema = versionFieldsSchema
  .extend({
    billingMode: z.literal("recurring"),
    billingPeriod: z.enum(["month", "year"]),
    addon: addonPayloadSchema,
  })
  .strict();

const serviceVersionCreateSchema = versionFieldsSchema
  .extend({
    billingMode: z.literal("one_time"),
    billingPeriod: z.null().optional(),
    service: z.object({}).strict(),
  })
  .strict();

export const catalogVersionCreateSchema = z.union([
  planVersionCreateSchema,
  addonVersionCreateSchema,
  serviceVersionCreateSchema,
]);

export const catalogVersionPatchSchema = z
  .object({
    nameRu: z.string().trim().min(1).max(300).optional(),
    nameEn: z.string().trim().min(1).max(300).optional(),
    descriptionRu: z.string().trim().max(10_000).nullable().optional(),
    descriptionEn: z.string().trim().max(10_000).nullable().optional(),
    unit: z.string().trim().min(1).max(100).optional(),
    billingMode: z.enum(["one_time", "recurring"]).optional(),
    billingPeriod: z.enum(["month", "year"]).nullable().optional(),
    unitPrice: z
      .string()
      .regex(/^\d{1,12}\.\d{2}$/, "Expected a decimal amount")
      .optional(),
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    vatIncluded: z.boolean().optional(),
    plan: legacyPlanEntitlementsSchema.optional(),
    addon: addonPayloadSchema.optional(),
    service: z.object({}).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const effectKinds = [value.plan, value.addon, value.service].filter(
      (effect) => effect !== undefined,
    );
    if (effectKinds.length > 1) {
      context.addIssue({ code: "custom", message: "Only one entitlement effect is allowed" });
    }
  });

const assignablePlanSchema = assignableCatalogVersionSchema.shape.plan.unwrap();
const assignableAddonSchema = assignableCatalogVersionSchema.shape.addon.unwrap();
const assignableServiceSchema = assignableCatalogVersionSchema.shape.service.unwrap();

const planVersionResponseSchema = assignableCatalogVersionSchema
  .safeExtend({
    kind: z.literal("plan"),
    billingMode: z.literal("recurring"),
    billingPeriod: z.enum(["month", "year"]),
    plan: assignablePlanSchema,
    addon: z.never().optional(),
    service: z.never().optional(),
  })
  .strict();

const addonVersionResponseSchema = assignableCatalogVersionSchema
  .safeExtend({
    kind: z.literal("addon"),
    billingMode: z.literal("recurring"),
    billingPeriod: z.enum(["month", "year"]),
    plan: z.never().optional(),
    addon: assignableAddonSchema,
    service: z.never().optional(),
  })
  .strict();

const serviceVersionResponseSchema = assignableCatalogVersionSchema
  .safeExtend({
    kind: z.literal("service"),
    billingMode: z.literal("one_time"),
    billingPeriod: z.null(),
    plan: z.never().optional(),
    addon: z.never().optional(),
    service: assignableServiceSchema,
  })
  .strict();

export const catalogVersionSchema = z.discriminatedUnion("kind", [
  planVersionResponseSchema,
  addonVersionResponseSchema,
  serviceVersionResponseSchema,
]);

const draftCatalogVersionSchema = catalogVersionSchema.refine(
  (version) => version.status === "draft",
  { path: ["status"], message: "Expected a draft catalog version" },
);
const publishedCatalogVersionSchema = catalogVersionSchema.refine(
  (version) => version.status === "published",
  { path: ["status"], message: "Expected a published catalog version" },
);
const retiredCatalogVersionSchema = catalogVersionSchema.refine(
  (version) => version.status === "retired",
  { path: ["status"], message: "Expected a retired catalog version" },
);

export const catalogVersionListResponseSchema = assignableCatalogResponseSchema
  .extend({ items: z.array(catalogVersionSchema) })
  .strict();

export const catalogItemParamsSchema = z.object({ id: catalogItemReferenceSchema }).strict();
export const catalogMachineCodeParamsSchema = z.object({ id: catalogMachineCodeSchema }).strict();
export const catalogVersionParamsSchema = z
  .object({ id: catalogItemReferenceSchema, versionId: catalogVersionIdSchema })
  .strict();
export const setDefaultDemoPlanSchema = z
  .object({ catalogVersionId: catalogVersionIdSchema })
  .strict();
export const defaultDemoPlanResponseSchema = z
  .object({ catalogVersionId: catalogVersionIdSchema.nullable() })
  .strict();
export const archiveCatalogItemResponseSchema = z
  .object({ status: z.literal("archived") })
  .strict();

export const platformCatalogContracts = {
  list: { response: catalogVersionListResponseSchema },
  listVersions: { params: catalogItemParamsSchema, response: catalogVersionListResponseSchema },
  getVersion: { params: catalogVersionParamsSchema, response: catalogVersionSchema },
  createVersion: {
    params: catalogMachineCodeParamsSchema,
    body: catalogVersionCreateSchema,
    response: draftCatalogVersionSchema,
  },
  updateVersion: {
    params: catalogVersionParamsSchema,
    body: catalogVersionPatchSchema,
    response: draftCatalogVersionSchema,
  },
  publishVersion: { params: catalogVersionParamsSchema, response: publishedCatalogVersionSchema },
  retireVersion: { params: catalogVersionParamsSchema, response: retiredCatalogVersionSchema },
  archiveItem: { params: catalogItemParamsSchema, response: archiveCatalogItemResponseSchema },
  getDefaultDemo: { response: defaultDemoPlanResponseSchema },
  setDefaultDemo: {
    body: setDefaultDemoPlanSchema,
    response: setDefaultDemoPlanSchema,
  },
} as const;

export type PlanEntitlements = z.output<typeof planEntitlementsSchema>;
export type AddonEffect = z.output<typeof addonEffectSchema>;
export type CatalogVersion = z.output<typeof catalogVersionSchema>;
export type CatalogVersionListResponse = z.output<typeof catalogVersionListResponseSchema>;
export type CatalogVersionCreate = z.output<typeof catalogVersionCreateSchema>;
export type CatalogVersionPatch = z.output<typeof catalogVersionPatchSchema>;
export type SetDefaultDemoPlan = z.output<typeof setDefaultDemoPlanSchema>;
export type DefaultDemoPlanResponse = z.output<typeof defaultDemoPlanResponseSchema>;
export type ArchiveCatalogItemResponse = z.output<typeof archiveCatalogItemResponseSchema>;

// Existing wire contracts remain V1 until a caller explicitly negotiates V2.
export const legacyCatalogVersionCreateSchema = catalogVersionCreateSchema;
export const legacyCatalogVersionPatchSchema = catalogVersionPatchSchema;
export const legacyCatalogVersionSchema = catalogVersionSchema;
export const legacyPlatformCatalogContracts = platformCatalogContracts;
const optionalMetadataShape = {
  documentNameRu: catalogCommercialMetadataShape.documentNameRu.optional(),
  documentNameEn: catalogCommercialMetadataShape.documentNameEn.optional(),
  subject: catalogCommercialMetadataShape.subject.optional(),
  sellerPolicyRevision: catalogCommercialMetadataShape.sellerPolicyRevision.optional(),
};
const licenseSubject = catalogCommercialMetadataShape.subject
  .unwrap()
  .extract(["software_license"])
  .nullable();
const serviceSubject = catalogCommercialMetadataShape.subject
  .unwrap()
  .extract(["service", "development_work"])
  .nullable();
export const catalogVersionCreateV2Schema = z.union([
  planVersionCreateSchema.extend({
    ...optionalMetadataShape,
    subject: licenseSubject.optional(),
    plan: planEntitlementsSchema,
  }),
  addonVersionCreateSchema.extend({ ...optionalMetadataShape, subject: licenseSubject.optional() }),
  serviceVersionCreateSchema.extend({
    ...optionalMetadataShape,
    subject: serviceSubject.optional(),
  }),
]);
export const catalogVersionPatchV2Schema = catalogVersionPatchSchema
  .safeExtend({ ...optionalMetadataShape, plan: planEntitlementsSchema.optional() })
  .superRefine(validateCatalogPatchCommercialTerms);
export const catalogVersionV2Schema = z.discriminatedUnion("kind", [
  planVersionResponseSchema.safeExtend({
    ...catalogCommercialMetadataShape,
    subject: licenseSubject,
    plan: planEntitlementsSchema,
  }),
  addonVersionResponseSchema.safeExtend({
    ...catalogCommercialMetadataShape,
    subject: licenseSubject,
    addon: addonPayloadSchema,
  }),
  serviceVersionResponseSchema.safeExtend({
    ...catalogCommercialMetadataShape,
    subject: serviceSubject,
  }),
]);
export const catalogVersionListResponseV2Schema = z
  .object({ items: z.array(catalogVersionV2Schema) })
  .strict();
export const commercialReviewIdentitySchema = z
  .object({
    catalogVersionId: catalogVersionIdSchema,
    draftUpdatedAt: platformTimestampSchema,
    sellerPolicyRevision: z.number().int().nonnegative(),
  })
  .strict();
export const catalogPublicationReviewSchema = z
  .object({
    identity: commercialReviewIdentitySchema,
    errors: z.array(z.object({ code: z.string(), path: z.string() }).strict()),
  })
  .strict();
export const catalogEditorContextSchema = z
  .object({
    sellerPolicyRevision: z.number().int().nonnegative(),
    taxPolicy: sellerTaxPolicySchema.nullable(),
    taxDefaults: z
      .object({ vatRateBps: z.number().int().nullable(), vatIncluded: z.boolean() })
      .strict()
      .nullable(),
    canWrite: z.boolean(),
  })
  .strict();
export type CommercialReviewIdentity = z.output<typeof commercialReviewIdentitySchema>;
export type CatalogPublicationReview = z.output<typeof catalogPublicationReviewSchema>;
export const platformCatalogV2Contracts = {
  ...platformCatalogContracts,
  editorContext: { response: catalogEditorContextSchema },
  reviewVersion: { params: catalogVersionParamsSchema, response: catalogPublicationReviewSchema },
  list: { response: catalogVersionListResponseV2Schema },
  listVersions: { params: catalogItemParamsSchema, response: catalogVersionListResponseV2Schema },
  getVersion: { params: catalogVersionParamsSchema, response: catalogVersionV2Schema },
  createVersion: {
    params: catalogMachineCodeParamsSchema,
    body: catalogVersionCreateV2Schema,
    response: catalogVersionV2Schema.refine((v) => v.status === "draft"),
  },
  updateVersion: {
    params: catalogVersionParamsSchema,
    body: catalogVersionPatchV2Schema,
    response: catalogVersionV2Schema.refine((v) => v.status === "draft"),
  },
  publishVersion: {
    params: catalogVersionParamsSchema,
    body: commercialReviewIdentitySchema,
    response: catalogVersionV2Schema.refine((v) => v.status === "published"),
  },
  retireVersion: {
    params: catalogVersionParamsSchema,
    response: catalogVersionV2Schema.refine((v) => v.status === "retired"),
  },
} as const;
export type CatalogVersionV2 = z.output<typeof catalogVersionV2Schema>;
export type CatalogVersionCreateV2 = z.output<typeof catalogVersionCreateV2Schema>;
export type CatalogVersionPatchV2 = z.output<typeof catalogVersionPatchV2Schema>;
