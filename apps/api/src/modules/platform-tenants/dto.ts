import { schema } from "@markiro/db";
import { z } from "zod";

const normalizedEmailSchema = z
  .string()
  .transform((value) => value.trim().toLocaleLowerCase("en-US"))
  .pipe(z.email());

export const tenantReferenceSchema = z.string().trim().min(1).max(128);

export const provisionTenantSchema = z
  .object({
    email: normalizedEmailSchema,
    tenantName: z.string().trim().min(1).max(300),
    tenantSlug: z
      .string()
      .trim()
      .max(128)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "tenant slug must use lowercase letters, digits, and hyphens",
      ),
  })
  .strict();
export type ProvisionTenantDto = z.infer<typeof provisionTenantSchema>;

export const tenantListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum([...schema.SUBSCRIPTION_STATUSES, "unmanaged"]).optional(),
  })
  .strict();
export type TenantListQueryDto = z.infer<typeof tenantListQuerySchema>;

const reasonSchema = z.string().trim().min(1).max(1_000);
const timestampSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const assignPlanSchema = z
  .object({
    catalogVersionId: z.uuid(),
    activationPolicy: z.enum(["immediate", "after_current"]),
    effectiveAt: timestampSchema.optional(),
    endsAt: timestampSchema.optional(),
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
export type AssignPlanDto = z.infer<typeof assignPlanSchema>;

export const assignAddonSchema = z
  .object({
    catalogVersionId: z.uuid(),
    expectedSubscriptionId: z.uuid(),
    quantity: z.number().int().min(1).max(2_147_483_647),
    activationPolicy: z.enum(["immediate", "after_current"]),
    effectiveAt: timestampSchema.optional(),
    endsAt: timestampSchema.optional(),
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
export type AssignAddonDto = z.infer<typeof assignAddonSchema>;
