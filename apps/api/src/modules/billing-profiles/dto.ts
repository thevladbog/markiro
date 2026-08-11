import { z } from "zod";

export const billingProfileSchema = z
  .object({
    kind: z.enum(["individual", "self_employed", "sole_proprietor", "legal_entity"]),
    displayName: z.string().trim().min(1).max(300),
    inn: z.string().trim().max(20).nullable().optional(),
    kpp: z.string().trim().max(20).nullable().optional(),
    ogrn: z.string().trim().max(20).nullable().optional(),
    ogrnip: z.string().trim().max(20).nullable().optional(),
    addressRaw: z.string().trim().min(1).max(1_000),
    address: z.record(z.string(), z.unknown()).nullable().optional(),
    bankDetails: z.record(z.string(), z.unknown()).nullable().optional(),
    contact: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export type BillingProfileInput = z.infer<typeof billingProfileSchema>;
