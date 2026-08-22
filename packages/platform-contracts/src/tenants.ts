import { z } from "zod";
import {
  platformMoneySchema,
  platformTenantIdSchema,
  platformTimestampSchema,
  platformUuidSchema,
} from "./primitives.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const tenantSubscriptionStatusSchema = z.enum([
  "pending_activation",
  "scheduled",
  "trial",
  "active",
  "expired",
  "superseded",
  "cancelled",
]);
export const tenantSubscriptionSourceSchema = z.enum([
  "demo",
  "manual",
  "paid_offer_line",
  "paid_invoice_line",
]);
export const tenantSubscriptionStatusFilterSchema = z.union([
  tenantSubscriptionStatusSchema,
  z.literal("unmanaged"),
]);
export const tenantActivationPolicySchema = z.enum(["immediate", "after_current"]);

const catalogStatusSchema = z.enum(["draft", "published", "retired"]);
const catalogKindSchema = z.enum(["plan", "addon", "service"]);
const billingModeSchema = z.enum(["one_time", "recurring"]);
const billingPeriodSchema = z.enum(["month", "year"]).nullable();
const nullableQuotaSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX).nullable();

const responseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);
const nullableResponseTimestampSchema = responseTimestampSchema.nullable();
const assignmentTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const normalizedEmailSchema = z
  .string()
  .transform((value) => value.trim().toLocaleLowerCase("en-US"))
  .pipe(z.email("email"));
const reasonSchema = z.string().trim().min(1).max(1_000);

export const tenantParamsSchema = z.object({ id: platformTenantIdSchema }).strict();

export const tenantListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: tenantSubscriptionStatusFilterSchema.optional(),
  })
  .strict();

const listPlanVersionSchema = z.object({
  id: platformUuidSchema.nullable(),
  version: z.number().int().positive().nullable(),
  nameRu: z.string().nullable(),
  nameEn: z.string().nullable(),
  unitPrice: platformMoneySchema.nullable().optional(),
});

export const tenantListItemSchema = z.object({
  id: platformTenantIdSchema,
  name: z.string().min(1).max(300),
  slug: z.string().min(1).max(128),
  createdAt: responseTimestampSchema,
  subscriptionStatus: tenantSubscriptionStatusFilterSchema,
  subscription: z
    .object({
      id: platformUuidSchema,
      status: tenantSubscriptionStatusSchema.nullable(),
      startsAt: nullableResponseTimestampSchema,
      endsAt: nullableResponseTimestampSchema,
      planVersion: listPlanVersionSchema,
    })
    .optional(),
});

export const tenantListResponseSchema = z.object({
  items: z.array(tenantListItemSchema),
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});

const planEntitlementsSchema = z.object({
  maxLines: nullableQuotaSchema,
  maxStations: nullableQuotaSchema,
  maxKiosks: nullableQuotaSchema,
  maxCabinetUsers: nullableQuotaSchema,
  labelEditorEnabled: z.boolean(),
  publicApiEnabled: z.boolean(),
  palletsEnabled: z.boolean(),
  demoDurationDays: z.number().int().positive().max(POSTGRES_INTEGER_MAX).nullable(),
});

const detailCatalogVersionBaseSchema = z.object({
  id: platformUuidSchema,
  catalogItemId: platformUuidSchema,
  catalogItemCode: z.string().min(1).max(128).nullable(),
  kind: catalogKindSchema,
  version: z.number().int().positive(),
  status: catalogStatusSchema,
  nameRu: z.string().min(1).max(300),
  nameEn: z.string().min(1).max(300),
  unit: z.string().min(1).max(100),
  billingMode: billingModeSchema,
  billingPeriod: billingPeriodSchema,
  unitPrice: platformMoneySchema.optional(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  vatIncluded: z.boolean().optional(),
});

const detailPlanVersionSchema = detailCatalogVersionBaseSchema.extend({
  kind: z.literal("plan"),
  entitlements: planEntitlementsSchema.nullable(),
});

const addonEffectSchema = z.object({
  entitlementKey: z.enum([
    "lines",
    "stations",
    "kiosks",
    "cabinetUsers",
    "labelEditor",
    "publicApi",
    "pallets",
  ]),
  quotaIncrement: z.number().int().positive().max(POSTGRES_INTEGER_MAX).nullable(),
  featureEnabled: z.boolean(),
});

const detailAddonVersionSchema = detailCatalogVersionBaseSchema.extend({
  kind: z.literal("addon"),
  effects: z.array(addonEffectSchema).min(1).max(7),
});

const tenantSubscriptionSchema = z.object({
  id: platformUuidSchema,
  tenantId: platformTenantIdSchema,
  planVersionId: platformUuidSchema,
  status: tenantSubscriptionStatusSchema,
  startsAt: nullableResponseTimestampSchema,
  endsAt: nullableResponseTimestampSchema,
  source: tenantSubscriptionSourceSchema,
  createdByPlatformUserId: z.string().nullable(),
  createdAt: responseTimestampSchema,
  updatedAt: responseTimestampSchema,
  planVersion: detailPlanVersionSchema,
});

const tenantSubscriptionAddonSchema = z.object({
  id: platformUuidSchema,
  subscriptionId: platformUuidSchema,
  addonVersionId: platformUuidSchema,
  quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  startsAt: nullableResponseTimestampSchema,
  endsAt: nullableResponseTimestampSchema,
  status: z.enum(["scheduled", "active", "expired", "revoked"]),
  source: tenantSubscriptionSourceSchema,
  addonVersion: detailAddonVersionSchema,
});

export const tenantDetailSchema = z.object({
  tenant: z.object({
    id: platformTenantIdSchema,
    name: z.string().min(1).max(300),
    slug: z.string().min(1).max(128),
    createdAt: responseTimestampSchema,
  }),
  subscriptionStatus: tenantSubscriptionStatusFilterSchema,
  ownerActivation: z
    .object({
      ownerUserId: z.string().min(1).max(128),
      ownerEmail: z.email(),
      emailVerified: z.boolean(),
      deliveryId: platformUuidSchema.nullable(),
      status: z.string().min(1).max(64),
      createdAt: nullableResponseTimestampSchema,
      updatedAt: nullableResponseTimestampSchema,
      terminalAt: nullableResponseTimestampSchema,
    })
    .nullable(),
  currentSubscription: tenantSubscriptionSchema.nullable(),
  scheduledSubscription: tenantSubscriptionSchema.nullable(),
  activeAddons: z.array(tenantSubscriptionAddonSchema),
  scheduledAddons: z.array(tenantSubscriptionAddonSchema),
  usage: z.object({
    cabinetUsers: z.number().int().min(0),
    kiosks: z.number().int().min(0),
    lines: z.number().int().min(0),
    stations: z.number().int().min(0),
  }),
  events: z.array(
    z.object({
      id: platformUuidSchema,
      subscriptionId: platformUuidSchema,
      eventKind: z.string().min(1).max(128),
      effectiveAt: responseTimestampSchema,
      source: z.string().min(1).max(128),
      reason: z.string().max(1_000).nullable(),
      before: z.unknown(),
      after: z.unknown(),
      createdAt: responseTimestampSchema,
    }),
  ),
});

const quotaAddonEffectSchema = z.object({
  key: z.enum(["lines", "stations", "kiosks", "cabinetUsers"]),
  quotaIncrement: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
});
const featureAddonEffectSchema = z.object({
  key: z.enum(["labelEditor", "publicApi", "pallets"]),
  featureEnabled: z.literal(true),
});

export const assignableCatalogVersionSchema = z
  .object({
    id: platformUuidSchema,
    catalogItemId: platformUuidSchema,
    catalogItemCode: z.string().min(1).max(128),
    kind: catalogKindSchema,
    version: z.number().int().positive(),
    status: catalogStatusSchema,
    nameRu: z.string().min(1).max(300),
    nameEn: z.string().min(1).max(300),
    descriptionRu: z.string().max(10_000).nullable(),
    descriptionEn: z.string().max(10_000).nullable(),
    unit: z.string().min(1).max(100),
    billingMode: billingModeSchema,
    billingPeriod: billingPeriodSchema,
    unitPrice: platformMoneySchema.optional(),
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    vatIncluded: z.boolean().optional(),
    publishedAt: nullableResponseTimestampSchema,
    publishedByPlatformUserId: z.string().nullable(),
    plan: planEntitlementsSchema.optional(),
    addon: z
      .object({
        effects: z.array(z.union([quotaAddonEffectSchema, featureAddonEffectSchema])).min(1),
      })
      .optional(),
    service: z.object({}).strict().optional(),
  })
  .superRefine((value, context) => {
    const disclosedFinancialFields = [value.unitPrice, value.vatRateBps, value.vatIncluded].filter(
      (field) => field !== undefined,
    ).length;
    if (disclosedFinancialFields !== 0 && disclosedFinancialFields !== 3) {
      context.addIssue({
        code: "custom",
        path: ["unitPrice"],
        message: "Financial terms must be fully disclosed or fully omitted",
      });
    }
  });

export const assignableCatalogResponseSchema = z.object({
  items: z.array(assignableCatalogVersionSchema),
});

export const createTenantSchema = z
  .object({
    tenantName: z.string().trim().min(1, "required").max(300, "nameTooLong"),
    tenantSlug: z
      .string()
      .trim()
      .max(128, "slugTooLong")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug"),
    email: normalizedEmailSchema,
  })
  .strict();

export const createTenantResponseSchema = z.object({
  tenantId: platformTenantIdSchema,
  userId: z.string().min(1).max(128),
  memberId: z.string().min(1).max(128),
  deliveryId: platformUuidSchema,
});

export const renewTenantActivationResponseSchema = z.object({
  deliveryId: platformUuidSchema,
});

export const assignPlanSchema = z
  .object({
    catalogVersionId: platformUuidSchema,
    activationPolicy: tenantActivationPolicySchema,
    effectiveAt: assignmentTimestampSchema.optional(),
    endsAt: assignmentTimestampSchema.optional(),
    reason: reasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.activationPolicy === "after_current" && value.effectiveAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["effectiveAt"],
        message: "after_current derives its start from the current subscription",
      });
    }
    if (value.effectiveAt && value.endsAt && value.endsAt <= value.effectiveAt) {
      context.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be later" });
    }
  });

export const assignAddonSchema = z
  .object({
    catalogVersionId: platformUuidSchema,
    expectedSubscriptionId: platformUuidSchema,
    quantity: z.number().int().min(1).max(POSTGRES_INTEGER_MAX),
    activationPolicy: tenantActivationPolicySchema,
    effectiveAt: assignmentTimestampSchema.optional(),
    endsAt: assignmentTimestampSchema.optional(),
    reason: reasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.activationPolicy === "after_current" && value.effectiveAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["effectiveAt"],
        message: "after_current derives its start from the scheduled subscription",
      });
    }
    if (value.effectiveAt && value.endsAt && value.endsAt <= value.effectiveAt) {
      context.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be later" });
    }
  });

export const planAssignmentResponseSchema = z.object({
  id: platformUuidSchema,
  tenantId: platformTenantIdSchema,
  planVersionId: platformUuidSchema,
  status: z.enum(["active", "scheduled"]),
  startsAt: responseTimestampSchema,
  endsAt: nullableResponseTimestampSchema,
  source: z.literal("manual"),
});

export const addonAssignmentResponseSchema = z.object({
  id: platformUuidSchema,
  tenantId: platformTenantIdSchema,
  subscriptionId: platformUuidSchema,
  addonVersionId: platformUuidSchema,
  quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  startsAt: responseTimestampSchema,
  endsAt: nullableResponseTimestampSchema,
  status: z.enum(["active", "scheduled"]),
  source: z.literal("manual"),
});

export const platformTenantContracts = {
  list: { query: tenantListQuerySchema, response: tenantListResponseSchema },
  detail: { params: tenantParamsSchema, response: tenantDetailSchema },
  create: { body: createTenantSchema, response: createTenantResponseSchema },
  renewActivation: {
    params: tenantParamsSchema,
    response: renewTenantActivationResponseSchema,
  },
  assignPlan: {
    params: tenantParamsSchema,
    body: assignPlanSchema,
    response: planAssignmentResponseSchema,
  },
  assignAddon: {
    params: tenantParamsSchema,
    body: assignAddonSchema,
    response: addonAssignmentResponseSchema,
  },
} as const;

export type TenantListQuery = z.output<typeof tenantListQuerySchema>;
export type TenantListItem = z.output<typeof tenantListItemSchema>;
export type TenantListResult = z.output<typeof tenantListResponseSchema>;
export type TenantListResponse = z.output<typeof tenantListResponseSchema>;
export type TenantSubscriptionStatus = z.output<typeof tenantSubscriptionStatusFilterSchema>;
export type TenantDetailResult = z.output<typeof tenantDetailSchema>;
export type TenantDetail = z.output<typeof tenantDetailSchema>;
export type TenantSubscription = NonNullable<TenantDetail["currentSubscription"]>;
export type TenantSubscriptionAddon = TenantDetail["activeAddons"][number];
export type DetailPlanVersion = TenantSubscription["planVersion"];
export type AssignableCatalogVersion = z.output<typeof assignableCatalogVersionSchema>;
export type AssignableCatalogResponse = z.output<typeof assignableCatalogResponseSchema>;
export type CreateTenantInput = z.input<typeof createTenantSchema>;
export type CreateTenantDto = z.output<typeof createTenantSchema>;
export type CreateTenantResult = z.output<typeof createTenantResponseSchema>;
export type CreateTenantResponse = z.output<typeof createTenantResponseSchema>;
export type RenewTenantActivationResult = z.output<typeof renewTenantActivationResponseSchema>;
export type RenewTenantActivationResponse = z.output<typeof renewTenantActivationResponseSchema>;
export type AssignPlanInput = z.input<typeof assignPlanSchema>;
export type AssignPlanDto = z.output<typeof assignPlanSchema>;
export type PlanAssignmentResult = z.output<typeof planAssignmentResponseSchema>;
export type PlanAssignmentResponse = z.output<typeof planAssignmentResponseSchema>;
export type AssignAddonInput = z.input<typeof assignAddonSchema>;
export type AssignAddonDto = z.output<typeof assignAddonSchema>;
export type AddonAssignmentResult = z.output<typeof addonAssignmentResponseSchema>;
export type AddonAssignmentResponse = z.output<typeof addonAssignmentResponseSchema>;
