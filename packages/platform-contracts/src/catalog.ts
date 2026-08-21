import { z } from "zod";

import { platformUuidSchema } from "./primitives.js";
import { assignableCatalogResponseSchema, assignableCatalogVersionSchema } from "./tenants.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positivePostgresIntegerSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nullablePositiveIntegerSchema = positivePostgresIntegerSchema.nullable();

export const catalogMachineCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const catalogItemReferenceSchema = z.union([platformUuidSchema, catalogMachineCodeSchema]);
export const catalogVersionIdSchema = platformUuidSchema;

export const planEntitlementsSchema = z
  .object({
    maxLines: nullablePositiveIntegerSchema,
    maxStations: nullablePositiveIntegerSchema,
    maxKiosks: nullablePositiveIntegerSchema,
    maxCabinetUsers: nullablePositiveIntegerSchema,
    labelEditorEnabled: z.boolean(),
    publicApiEnabled: z.boolean(),
    palletsEnabled: z.boolean(),
    demoDurationDays: nullablePositiveIntegerSchema,
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
    plan: planEntitlementsSchema,
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
    plan: planEntitlementsSchema.optional(),
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
