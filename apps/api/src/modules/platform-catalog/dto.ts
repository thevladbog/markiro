import { z } from "zod";

const decimalMoneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/, "Expected a decimal amount");
const nullablePositiveInteger = z.number().int().positive().nullable();

const versionFieldsSchema = z.object({
  nameRu: z.string().trim().min(1).max(300),
  nameEn: z.string().trim().min(1).max(300),
  descriptionRu: z.string().trim().max(10_000).nullable().optional(),
  descriptionEn: z.string().trim().max(10_000).nullable().optional(),
  unit: z.string().trim().min(1).max(100),
  billingMode: z.enum(["one_time", "recurring"]),
  billingPeriod: z.enum(["month", "year"]).nullable().optional(),
  unitPrice: decimalMoneySchema,
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  vatIncluded: z.boolean(),
});

export const planEntitlementSchema = z
  .object({
    maxLines: nullablePositiveInteger,
    maxStations: nullablePositiveInteger,
    maxKiosks: nullablePositiveInteger,
    maxCabinetUsers: nullablePositiveInteger,
    labelEditorEnabled: z.boolean(),
    publicApiEnabled: z.boolean(),
    palletsEnabled: z.boolean(),
    demoDurationDays: nullablePositiveInteger,
  })
  .strict();

const addonEffectSchema = z.discriminatedUnion("key", [
  z.object({
    key: z.enum(["lines", "stations", "kiosks", "cabinetUsers"]),
    quotaIncrement: z.number().int().positive(),
  }),
  z.object({
    key: z.enum(["labelEditor", "publicApi", "pallets"]),
    featureEnabled: z.literal(true),
  }),
]);

const planVersionSchema = versionFieldsSchema
  .extend({ plan: planEntitlementSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.billingMode !== "recurring" || !value.billingPeriod) {
      context.addIssue({ code: "custom", path: ["billingMode"], message: "Plans are recurring" });
    }
  });

const addonVersionSchema = versionFieldsSchema
  .extend({ addon: z.object({ effects: z.array(addonEffectSchema).min(1).max(7) }).strict() })
  .strict()
  .superRefine((value, context) => {
    if (value.billingMode !== "recurring" || !value.billingPeriod) {
      context.addIssue({ code: "custom", path: ["billingMode"], message: "Add-ons are recurring" });
    }
    const keys = value.addon.effects.map((effect) => effect.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["addon", "effects"],
        message: "Effect keys must be unique",
      });
    }
  });

const serviceVersionSchema = versionFieldsSchema
  .extend({ service: z.object({}).strict() })
  .strict()
  .superRefine((value, context) => {
    if (
      value.billingMode !== "one_time" ||
      (value.billingPeriod !== null && value.billingPeriod !== undefined)
    ) {
      context.addIssue({ code: "custom", path: ["billingMode"], message: "Services are one-time" });
    }
  });

export const createCatalogVersionSchema = z.union([
  planVersionSchema,
  addonVersionSchema,
  serviceVersionSchema,
]);
export type CreateCatalogVersionDto = z.infer<typeof createCatalogVersionSchema>;

export const updateCatalogVersionSchema = z
  .object({
    nameRu: z.string().trim().min(1).max(300).optional(),
    nameEn: z.string().trim().min(1).max(300).optional(),
    descriptionRu: z.string().trim().max(10_000).nullable().optional(),
    descriptionEn: z.string().trim().max(10_000).nullable().optional(),
    unit: z.string().trim().min(1).max(100).optional(),
    billingMode: z.enum(["one_time", "recurring"]).optional(),
    billingPeriod: z.enum(["month", "year"]).nullable().optional(),
    unitPrice: decimalMoneySchema.optional(),
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    vatIncluded: z.boolean().optional(),
    plan: planEntitlementSchema.optional(),
    addon: z
      .object({ effects: z.array(addonEffectSchema).min(1).max(7) })
      .strict()
      .optional(),
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
    if (value.addon) {
      const keys = value.addon.effects.map((effect) => effect.key);
      if (new Set(keys).size !== keys.length) {
        context.addIssue({
          code: "custom",
          path: ["addon", "effects"],
          message: "Effect keys must be unique",
        });
      }
    }
  });
export type UpdateCatalogVersionDto = z.infer<typeof updateCatalogVersionSchema>;

export const setDefaultDemoPlanSchema = z.object({ catalogVersionId: z.uuid() }).strict();
export type SetDefaultDemoPlanDto = z.infer<typeof setDefaultDemoPlanSchema>;

export const catalogMachineCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const catalogItemReferenceSchema = z.union([z.uuid(), catalogMachineCodeSchema]);
export const catalogVersionIdSchema = z.uuid();

export interface CatalogVersionDto {
  id: string;
  catalogItemId: string;
  catalogItemCode: string;
  kind: "plan" | "addon" | "service";
  version: number;
  status: "draft" | "published" | "retired";
  nameRu: string;
  nameEn: string;
  descriptionRu: string | null;
  descriptionEn: string | null;
  unit: string;
  billingMode: "one_time" | "recurring";
  billingPeriod: "month" | "year" | null;
  unitPrice?: string;
  vatRateBps?: number | null;
  vatIncluded?: boolean;
  publishedAt: Date | null;
  publishedByPlatformUserId: string | null;
  plan?: z.infer<typeof planEntitlementSchema>;
  addon?: { effects: z.infer<typeof addonEffectSchema>[] };
  service?: Record<string, never>;
}
