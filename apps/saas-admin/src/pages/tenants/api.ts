import { z } from "zod";

import { platformApiFetch } from "../../api/client.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const isoDateSchema = z.iso.datetime({ offset: true });
const nullableIsoDateSchema = isoDateSchema.nullable();
const subscriptionStatusSchema = z.enum([
  "pending_activation",
  "scheduled",
  "trial",
  "active",
  "expired",
  "superseded",
  "cancelled",
]);
const subscriptionSourceSchema = z.enum(["demo", "manual", "paid_offer_line"]);
const activationPolicySchema = z.enum(["immediate", "after_current"]);
const catalogStatusSchema = z.enum(["draft", "published", "retired"]);
const catalogKindSchema = z.enum(["plan", "addon", "service"]);
const billingModeSchema = z.enum(["one_time", "recurring"]);
const billingPeriodSchema = z.enum(["month", "year"]).nullable();
const nullableQuotaSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX).nullable();
const moneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);

export const tenantIdSchema = z.uuid();

const listPlanVersionSchema = z.object({
  id: z.uuid().nullable(),
  version: z.number().int().positive().nullable(),
  nameRu: z.string().nullable(),
  nameEn: z.string().nullable(),
  unitPrice: moneySchema.nullable().optional(),
});

const tenantListItemSchema = z.object({
  id: tenantIdSchema,
  name: z.string().min(1).max(300),
  slug: z.string().min(1).max(128),
  createdAt: isoDateSchema,
  subscriptionStatus: z.union([subscriptionStatusSchema, z.literal("unmanaged")]),
  subscription: z
    .object({
      id: z.uuid(),
      status: subscriptionStatusSchema.nullable(),
      startsAt: nullableIsoDateSchema,
      endsAt: nullableIsoDateSchema,
      planVersion: listPlanVersionSchema,
    })
    .optional(),
});

const tenantListResponseSchema = z.object({
  items: z.array(tenantListItemSchema),
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
});

export type TenantListItem = z.infer<typeof tenantListItemSchema>;
export type TenantListResponse = z.infer<typeof tenantListResponseSchema>;
export type TenantSubscriptionStatus = TenantListItem["subscriptionStatus"];

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
  id: z.uuid(),
  catalogItemId: z.uuid(),
  catalogItemCode: z.string().min(1).max(128).nullable(),
  kind: catalogKindSchema,
  version: z.number().int().positive(),
  status: catalogStatusSchema,
  nameRu: z.string().min(1).max(300),
  nameEn: z.string().min(1).max(300),
  unit: z.string().min(1).max(100),
  billingMode: billingModeSchema,
  billingPeriod: billingPeriodSchema,
  unitPrice: moneySchema.optional(),
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

const subscriptionSchema = z.object({
  id: z.uuid(),
  tenantId: tenantIdSchema,
  planVersionId: z.uuid(),
  status: subscriptionStatusSchema,
  startsAt: nullableIsoDateSchema,
  endsAt: nullableIsoDateSchema,
  source: subscriptionSourceSchema,
  createdByPlatformUserId: z.string().nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  planVersion: detailPlanVersionSchema,
});

const subscriptionAddonSchema = z.object({
  id: z.uuid(),
  subscriptionId: z.uuid(),
  addonVersionId: z.uuid(),
  quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  startsAt: nullableIsoDateSchema,
  endsAt: nullableIsoDateSchema,
  status: z.enum(["scheduled", "active", "expired", "revoked"]),
  source: subscriptionSourceSchema,
  addonVersion: detailAddonVersionSchema,
});

const tenantDetailSchema = z.object({
  tenant: z.object({
    id: tenantIdSchema,
    name: z.string().min(1).max(300),
    slug: z.string().min(1).max(128),
    createdAt: isoDateSchema,
  }),
  subscriptionStatus: z.union([subscriptionStatusSchema, z.literal("unmanaged")]),
  ownerActivation: z
    .object({
      ownerUserId: z.string().min(1).max(128),
      ownerEmail: z.email(),
      emailVerified: z.boolean(),
      deliveryId: z.uuid().nullable(),
      status: z.string().min(1).max(64),
      createdAt: nullableIsoDateSchema,
      updatedAt: nullableIsoDateSchema,
      terminalAt: nullableIsoDateSchema,
    })
    .nullable(),
  currentSubscription: subscriptionSchema.nullable(),
  scheduledSubscription: subscriptionSchema.nullable(),
  activeAddons: z.array(subscriptionAddonSchema),
  scheduledAddons: z.array(subscriptionAddonSchema),
  usage: z.object({
    cabinetUsers: z.number().int().min(0),
    kiosks: z.number().int().min(0),
    lines: z.number().int().min(0),
    stations: z.number().int().min(0),
  }),
  events: z.array(
    z.object({
      id: z.uuid(),
      subscriptionId: z.uuid(),
      eventKind: z.string().min(1).max(128),
      effectiveAt: isoDateSchema,
      source: z.string().min(1).max(128),
      reason: z.string().max(1_000).nullable(),
      before: z.unknown(),
      after: z.unknown(),
      createdAt: isoDateSchema,
    }),
  ),
});

export type TenantDetail = z.infer<typeof tenantDetailSchema>;
export type TenantSubscription = NonNullable<TenantDetail["currentSubscription"]>;
export type TenantSubscriptionAddon = TenantDetail["activeAddons"][number];
export type DetailPlanVersion = TenantSubscription["planVersion"];

const quotaAddonEffectSchema = z.object({
  key: z.enum(["lines", "stations", "kiosks", "cabinetUsers"]),
  quotaIncrement: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
});
const featureAddonEffectSchema = z.object({
  key: z.enum(["labelEditor", "publicApi", "pallets"]),
  featureEnabled: z.literal(true),
});

const assignableCatalogVersionSchema = z.object({
  id: z.uuid(),
  catalogItemId: z.uuid(),
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
  unitPrice: moneySchema.optional(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  vatIncluded: z.boolean().optional(),
  publishedAt: nullableIsoDateSchema,
  publishedByPlatformUserId: z.string().nullable(),
  plan: planEntitlementsSchema.optional(),
  addon: z
    .object({
      effects: z.array(z.union([quotaAddonEffectSchema, featureAddonEffectSchema])).min(1),
    })
    .optional(),
  service: z.object({}).optional(),
});

const assignableCatalogResponseSchema = z.object({
  items: z.array(assignableCatalogVersionSchema),
});

export type AssignableCatalogVersion = z.infer<typeof assignableCatalogVersionSchema>;

export const createTenantInputSchema = z.object({
  tenantName: z.string().trim().min(1, "required").max(300, "nameTooLong"),
  tenantSlug: z
    .string()
    .trim()
    .max(128, "slugTooLong")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug"),
  email: z
    .string()
    .transform((value) => value.trim().toLocaleLowerCase("en-US"))
    .pipe(z.email("email")),
});
export type CreateTenantInput = z.infer<typeof createTenantInputSchema>;

const createTenantResponseSchema = z.object({
  tenantId: tenantIdSchema,
  userId: z.string().min(1).max(128),
  memberId: z.string().min(1).max(128),
  deliveryId: z.uuid(),
});

export const assignPlanInputSchema = z.object({
  catalogVersionId: z.uuid(),
  activationPolicy: activationPolicySchema,
  endsAt: isoDateSchema.optional(),
  reason: z.string().trim().min(1).max(1_000),
});
export type AssignPlanInput = z.infer<typeof assignPlanInputSchema>;

export const assignAddonInputSchema = assignPlanInputSchema.extend({
  expectedSubscriptionId: z.uuid(),
  quantity: z.number().int().min(1).max(POSTGRES_INTEGER_MAX),
});
export type AssignAddonInput = z.infer<typeof assignAddonInputSchema>;

const planAssignmentResponseSchema = z.object({
  id: z.uuid(),
  tenantId: tenantIdSchema,
  planVersionId: z.uuid(),
  status: z.enum(["active", "scheduled"]),
  startsAt: isoDateSchema,
  endsAt: nullableIsoDateSchema,
  source: z.literal("manual"),
});

const addonAssignmentResponseSchema = z.object({
  id: z.uuid(),
  tenantId: tenantIdSchema,
  subscriptionId: z.uuid(),
  addonVersionId: z.uuid(),
  quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  startsAt: isoDateSchema,
  endsAt: nullableIsoDateSchema,
  status: z.enum(["active", "scheduled"]),
  source: z.literal("manual"),
});

export interface TenantListQuery {
  page: number;
  limit: number;
  status?: TenantSubscriptionStatus;
}

export async function listTenants(query: TenantListQuery): Promise<TenantListResponse> {
  const params = new URLSearchParams({ page: String(query.page), limit: String(query.limit) });
  if (query.status) params.set("status", query.status);
  const response = await platformApiFetch<unknown>(`/tenants?${params.toString()}`);
  return tenantListResponseSchema.parse(response);
}

export async function createTenant(input: CreateTenantInput) {
  const validated = createTenantInputSchema.parse(input);
  const response = await platformApiFetch<unknown>("/tenants", {
    method: "POST",
    body: JSON.stringify(validated),
  });
  return createTenantResponseSchema.parse(response);
}

export async function getTenant(tenantId: string): Promise<TenantDetail> {
  const validatedId = tenantIdSchema.parse(tenantId);
  const response = await platformApiFetch<unknown>(`/tenants/${validatedId}`);
  return tenantDetailSchema.parse(response);
}

export async function renewOwnerActivation(tenantId: string) {
  const validatedId = tenantIdSchema.parse(tenantId);
  const response = await platformApiFetch<unknown>(
    `/tenants/${validatedId}/owner-activation/renew`,
    { method: "POST", body: "{}" },
  );
  return z.object({ deliveryId: z.uuid() }).parse(response);
}

export async function listAssignableCatalogVersions() {
  const response = await platformApiFetch<unknown>("/catalog/items");
  return assignableCatalogResponseSchema.parse(response);
}

export async function assignTenantPlan(tenantId: string, input: AssignPlanInput) {
  const validatedId = tenantIdSchema.parse(tenantId);
  const validated = assignPlanInputSchema.parse(input);
  const response = await platformApiFetch<unknown>(`/tenants/${validatedId}/subscription/plan`, {
    method: "POST",
    body: JSON.stringify(validated),
  });
  return planAssignmentResponseSchema.parse(response);
}

export async function assignTenantAddon(tenantId: string, input: AssignAddonInput) {
  const validatedId = tenantIdSchema.parse(tenantId);
  const validated = assignAddonInputSchema.parse(input);
  const response = await platformApiFetch<unknown>(`/tenants/${validatedId}/subscription/addons`, {
    method: "POST",
    body: JSON.stringify(validated),
  });
  return addonAssignmentResponseSchema.parse(response);
}
