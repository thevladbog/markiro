import { z } from "zod";

const money = z.string().regex(/^\d{1,12}\.\d{2}$/, "Expected a decimal amount");
const lineSchema = z
  .object({
    kind: z.enum(["plan", "addon", "service", "custom"]),
    catalogVersionId: z.uuid().nullable().optional(),
    nameRu: z.string().trim().min(1).max(300).optional(),
    nameEn: z.string().trim().min(1).max(300).optional(),
    descriptionRu: z.string().max(10_000).nullable().optional(),
    descriptionEn: z.string().max(10_000).nullable().optional(),
    quantity: z.number().int().positive(),
    unit: z.string().trim().min(1).max(100).optional(),
    catalogUnitPrice: money.nullable().optional(),
    agreedUnitPrice: money,
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    vatIncluded: z.boolean(),
    activationPolicy: z.enum(["immediate", "after_current", "manual"]).nullable().optional(),
  })
  .strict();

export const createInvoiceSchema = z
  .object({
    tenantId: z.string().min(1),
    dueDate: z.coerce.date().nullable().optional(),
    applicationMode: z.enum(["manual", "automatic"]),
    lines: z.array(lineSchema).min(1).max(100),
  })
  .strict();
export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;

export const invoiceIdSchema = z.uuid();
