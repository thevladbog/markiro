import { z } from "zod";
import { planEntitlementsReadV3Schema } from "./catalog-v3.js";
import { ENTITLEMENT_FEATURE_KEYS, ENTITLEMENT_QUOTA_KEYS } from "./entitlements.js";
import { platformUuidSchema } from "./primitives.js";
import {
  platformTenantV2Contracts,
  tenantDetailV2Schema,
  tenantSubscriptionAddonV2Schema,
  tenantSubscriptionV2Schema,
} from "./tenants.js";

export const tenantAddonEffectV3Schema = z.discriminatedUnion("entitlementKey", [
  z
    .object({
      entitlementKey: z.enum(ENTITLEMENT_QUOTA_KEYS),
      quotaIncrement: z.number().int().positive().max(2_147_483_647),
      featureEnabled: z.literal(false),
    })
    .strict(),
  z
    .object({
      entitlementKey: z.enum(ENTITLEMENT_FEATURE_KEYS),
      quotaIncrement: z.null(),
      featureEnabled: z.literal(true),
    })
    .strict(),
]);
export const tenantSubscriptionV3Schema = tenantSubscriptionV2Schema
  .extend({
    planVersion: tenantSubscriptionV2Schema.shape.planVersion
      .extend({
        entitlements: planEntitlementsReadV3Schema.nullable(),
        lifecyclePolicyId: platformUuidSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export const tenantSubscriptionAddonV3Schema = tenantSubscriptionAddonV2Schema
  .extend({
    addonVersion: tenantSubscriptionAddonV2Schema.shape.addonVersion
      .extend({
        lifecyclePolicyId: platformUuidSchema.nullable(),
        effects: z
          .array(tenantAddonEffectV3Schema)
          .min(1)
          .max(ENTITLEMENT_FEATURE_KEYS.length + ENTITLEMENT_QUOTA_KEYS.length)
          .refine(
            (effects) =>
              new Set(effects.map((effect) => effect.entitlementKey)).size === effects.length,
            "Effect keys must be unique",
          ),
      })
      .strict(),
  })
  .strict();
export const tenantDetailV3Schema = tenantDetailV2Schema
  .extend({
    tenant: tenantDetailV2Schema.shape.tenant.strict(),
    ownerActivation: tenantDetailV2Schema.shape.ownerActivation.unwrap().strict().nullable(),
    usage: tenantDetailV2Schema.shape.usage.strict(),
    events: z.array(tenantDetailV2Schema.shape.events.element.strict()),
    currentSubscription: tenantSubscriptionV3Schema.nullable(),
    scheduledSubscription: tenantSubscriptionV3Schema.nullable(),
    activeAddons: z.array(tenantSubscriptionAddonV3Schema),
    scheduledAddons: z.array(tenantSubscriptionAddonV3Schema),
  })
  .strict();
export const platformTenantV3Contracts = {
  ...platformTenantV2Contracts,
  detail: { ...platformTenantV2Contracts.detail, response: tenantDetailV3Schema },
} as const;
export type TenantAddonEffectV3 = z.output<typeof tenantAddonEffectV3Schema>;
export type TenantSubscriptionV3 = z.output<typeof tenantSubscriptionV3Schema>;
export type TenantSubscriptionAddonV3 = z.output<typeof tenantSubscriptionAddonV3Schema>;
export type TenantDetailV3 = z.output<typeof tenantDetailV3Schema>;
