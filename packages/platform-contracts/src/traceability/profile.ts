import { z } from "zod";

export const usTraceabilityProfileCodeSchema = z.enum([
  "US_FSMA204_PROCESSOR",
  "US_GENERIC_LOT_TRACEABILITY",
]);

const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    if (/^[+-]/.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA timezone");

/** Initial provisioning only. Tenant, actor and baseline are server-owned. */
export const provisionUsTraceabilityProfileSchema = z
  .object({
    code: usTraceabilityProfileCodeSchema,
    timeZone: timeZoneSchema,
    retentionYears: z.number().int().min(2).max(2147483647).default(5),
  })
  .strict();

export type ProvisionUsTraceabilityProfileInput = z.infer<
  typeof provisionUsTraceabilityProfileSchema
>;

/** Persisted response: unlike input, a missing retention value must not default. */
export const usTraceabilityProfileSummarySchema = provisionUsTraceabilityProfileSchema.extend({
  retentionYears: z.number().int().min(2).max(2147483647),
  baselineVersion: z.string().min(1),
  effectiveAt: z.iso.datetime(),
});

export type UsTraceabilityProfileSummary = z.infer<typeof usTraceabilityProfileSummarySchema>;
