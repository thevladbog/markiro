import { z } from "zod";

export const TENANT_BILLING_RECIPIENT_NAME_MAX = 200;
export const TENANT_BILLING_ORGANIZATION_NAME_MAX = 300;
export const TENANT_BILLING_SUBJECT_NAME_MAX = 200;
export const TENANT_BILLING_ACTION_URL_MAX = 2_048;

const boundedText = (maximum: number) =>
  z.string().transform((value, context) => {
    const normalized = value.trim();
    if (!normalized) {
      context.addIssue({ code: "custom", message: "must not be blank" });
      return z.NEVER;
    }
    return Array.from(normalized).slice(0, maximum).join("");
  });

const actionUrl = z
  .string()
  .min(1)
  .max(TENANT_BILLING_ACTION_URL_MAX)
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "action URL must use http(s)",
  });

export const tenantBillingNotificationPayloadSchema = z
  .object({
    kind: z.literal("tenant-billing-notification"),
    locale: z.enum(["ru", "en"]),
    recipientName: boundedText(TENANT_BILLING_RECIPIENT_NAME_MAX),
    organizationName: boundedText(TENANT_BILLING_ORGANIZATION_NAME_MAX),
    eventKind: z.enum([
      "clarification_required",
      "offer_published",
      "invoice_due_soon",
      "act_ready",
    ]),
    subjectName: boundedText(TENANT_BILLING_SUBJECT_NAME_MAX),
    actionUrl,
  })
  .strict();

export type TenantBillingNotificationPayload = z.output<
  typeof tenantBillingNotificationPayloadSchema
>;

export function normalizeTenantBillingNotificationPayload(
  input: z.input<typeof tenantBillingNotificationPayloadSchema>,
): TenantBillingNotificationPayload {
  return tenantBillingNotificationPayloadSchema.parse(input);
}
