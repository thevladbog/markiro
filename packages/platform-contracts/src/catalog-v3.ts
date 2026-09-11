import { z } from "zod";
import { validateCatalogPatchCommercialTerms } from "./catalog-validation.js";
import {
  catalogVersionCreateV2Schema,
  catalogVersionPatchV2Schema,
  catalogVersionV2Schema,
  commercialReviewIdentitySchema,
  planEntitlementsSchema,
  platformCatalogV2Contracts,
} from "./catalog.js";
import { entitlementEffectSchema, entitlementEffectsSchema } from "./entitlements.js";
import { platformUuidSchema } from "./primitives.js";

export const planEntitlementsV3Schema = planEntitlementsSchema
  .extend({
    chzIntegrationEnabled: z.boolean(),
    inventoryEnabled: z.boolean(),
    commerceMlEnabled: z.boolean(),
    handheldEnabled: z.boolean(),
  })
  .strict();
export const planEntitlementsReadV3Schema = planEntitlementsV3Schema
  .extend({
    chzIntegrationEnabled: z.boolean().nullable(),
    inventoryEnabled: z.boolean().nullable(),
    commerceMlEnabled: z.boolean().nullable(),
    handheldEnabled: z.boolean().nullable(),
  })
  .strict();
export const addonEffectV3Schema = entitlementEffectSchema;
export const addonPayloadV3Schema = z.object({ effects: entitlementEffectsSchema }).strict();
const lifecyclePolicyShape = { lifecyclePolicyId: platformUuidSchema.nullable() };
const [planCreate, addonCreate, serviceCreate] = catalogVersionCreateV2Schema.options;
export const catalogVersionCreateV3Schema = z.union([
  planCreate.extend({ plan: planEntitlementsV3Schema, ...lifecyclePolicyShape }).strict(),
  addonCreate.extend({ addon: addonPayloadV3Schema, ...lifecyclePolicyShape }).strict(),
  serviceCreate.extend(lifecyclePolicyShape).strict(),
]);
export const catalogVersionPatchV3Schema = z
  .object({
    ...catalogVersionPatchV2Schema.shape,
    plan: planEntitlementsV3Schema.optional(),
    addon: addonPayloadV3Schema.optional(),
    lifecyclePolicyId: platformUuidSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ([value.plan, value.addon, value.service].filter((entry) => entry !== undefined).length > 1)
      ctx.addIssue({ code: "custom", message: "Only one entitlement effect is allowed" });
  })
  .superRefine(validateCatalogPatchCommercialTerms);
const [planRead, addonRead, serviceRead] = catalogVersionV2Schema.options;
// Rebuild only the versioned shapes; the legacy schema objects remain frozen.
const catalogVersionV3Union = z.discriminatedUnion("kind", [
  z
    .object({ ...planRead.shape, plan: planEntitlementsReadV3Schema, ...lifecyclePolicyShape })
    .strict(),
  z.object({ ...addonRead.shape, addon: addonPayloadV3Schema, ...lifecyclePolicyShape }).strict(),
  z.object({ ...serviceRead.shape, ...lifecyclePolicyShape }).strict(),
]);
export const catalogVersionV3Schema = catalogVersionV3Union.superRefine((value, ctx) => {
  const disclosed = [value.unitPrice, value.vatRateBps, value.vatIncluded].filter(
    (field) => field !== undefined,
  ).length;
  if (disclosed !== 0 && disclosed !== 3)
    ctx.addIssue({
      code: "custom",
      path: ["unitPrice"],
      message: "Financial terms must be fully disclosed or fully omitted",
    });
});
export const catalogVersionListResponseV3Schema = z
  .object({ items: z.array(catalogVersionV3Schema) })
  .strict();
export const assignableCatalogVersionV3Schema = catalogVersionV3Schema;
export const assignableCatalogResponseV3Schema = catalogVersionListResponseV3Schema;
export const commercialReviewIdentityV3Schema = commercialReviewIdentitySchema
  .extend({
    lifecyclePolicyId: platformUuidSchema,
    lifecyclePolicyVersion: z.number().int().positive(),
    lifecyclePolicyHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const catalogPublicationReviewV3Schema = z
  .object({
    identity: commercialReviewIdentitySchema
      .extend({
        ...lifecyclePolicyShape,
        lifecyclePolicyVersion: z.number().int().positive().nullable(),
        lifecyclePolicyHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      })
      .strict(),
    errors: z.array(z.object({ code: z.string(), path: z.string() }).strict()),
  })
  .strict();
const publishedCatalogVersionV3Schema = catalogVersionV3Schema.refine(
  (version) =>
    version.status === "published" &&
    version.lifecyclePolicyId !== null &&
    (version.kind !== "plan" || planEntitlementsV3Schema.safeParse(version.plan).success),
  "V3 publication requires explicit features and a lifecycle policy reference",
);
// Approval of the referenced lifecycle policy is a server-side publication check.
export const catalogEditorContextV3Schema = platformCatalogV2Contracts.editorContext.response
  .extend({
    lifecyclePolicies: z.array(
      z
        .object({
          id: platformUuidSchema,
          policyKey: z.string().min(1),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();
export const platformCatalogV3Contracts = {
  ...platformCatalogV2Contracts,
  editorContext: { response: catalogEditorContextV3Schema },
  reviewVersion: {
    ...platformCatalogV2Contracts.reviewVersion,
    response: catalogPublicationReviewV3Schema,
  },
  list: { response: catalogVersionListResponseV3Schema },
  listVersions: {
    ...platformCatalogV2Contracts.listVersions,
    response: catalogVersionListResponseV3Schema,
  },
  getVersion: { ...platformCatalogV2Contracts.getVersion, response: catalogVersionV3Schema },
  createVersion: {
    ...platformCatalogV2Contracts.createVersion,
    body: catalogVersionCreateV3Schema,
    response: catalogVersionV3Schema.refine((v) => v.status === "draft"),
  },
  updateVersion: {
    ...platformCatalogV2Contracts.updateVersion,
    body: catalogVersionPatchV3Schema,
    response: catalogVersionV3Schema.refine((v) => v.status === "draft"),
  },
  publishVersion: {
    ...platformCatalogV2Contracts.publishVersion,
    body: commercialReviewIdentityV3Schema,
    response: publishedCatalogVersionV3Schema,
  },
  retireVersion: {
    ...platformCatalogV2Contracts.retireVersion,
    response: catalogVersionV3Schema.refine((v) => v.status === "retired"),
  },
} as const;
export type PlanEntitlementsV3 = z.output<typeof planEntitlementsV3Schema>;
export type PlanEntitlementsReadV3 = z.output<typeof planEntitlementsReadV3Schema>;
export type AddonEffectV3 = z.output<typeof addonEffectV3Schema>;
export type AddonPayloadV3 = z.output<typeof addonPayloadV3Schema>;
export type CatalogVersionV3 = z.output<typeof catalogVersionV3Schema>;
export type CatalogVersionCreateV3 = z.output<typeof catalogVersionCreateV3Schema>;
export type CatalogVersionPatchV3 = z.output<typeof catalogVersionPatchV3Schema>;
export type CatalogVersionListResponseV3 = z.output<typeof catalogVersionListResponseV3Schema>;
export type AssignableCatalogVersionV3 = z.output<typeof assignableCatalogVersionV3Schema>;
export type AssignableCatalogResponseV3 = z.output<typeof assignableCatalogResponseV3Schema>;
export type CommercialReviewIdentityV3 = z.output<typeof commercialReviewIdentityV3Schema>;
export type CatalogPublicationReviewV3 = z.output<typeof catalogPublicationReviewV3Schema>;
