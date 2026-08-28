import { z } from "zod";

export const platformTenantIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
  .refine((value) => !value.includes(".."), "Tenant ID cannot contain a traversal alias");
export type PlatformTenantId = z.infer<typeof platformTenantIdSchema>;

export const platformUuidSchema = z.uuid().transform((value) => value.toLowerCase());
export type PlatformUuid = z.infer<typeof platformUuidSchema>;

export const platformMoneySchema = z.string().regex(/^\d{1,12}\.\d{2}$/);
export type PlatformMoney = z.infer<typeof platformMoneySchema>;

const normalizePlatformTimestamp = (value: unknown) => {
  if (typeof value !== "string") return value;

  let normalized = value.replace(" ", "T");
  if (/^[^T]+T/.test(normalized) && !/[zZ]|[+-]\d{2}(?::?\d{2})?$/.test(normalized)) {
    normalized += "Z";
  } else if (/[+-]\d{2}$/.test(normalized)) {
    normalized += ":00";
  }
  return normalized;
};

export const platformTimestampSchema = z
  .preprocess(normalizePlatformTimestamp, z.iso.datetime({ offset: true }))
  .transform((value) => new Date(value).toISOString());
export type PlatformTimestamp = z.infer<typeof platformTimestampSchema>;

export const platformNullableTimestampSchema = platformTimestampSchema.nullable();
export type PlatformNullableTimestamp = z.infer<typeof platformNullableTimestampSchema>;
