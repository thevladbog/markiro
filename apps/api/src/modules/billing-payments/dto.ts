import { z } from "zod";

const money = z.string().regex(/^\d{1,12}\.\d{2}$/);
export const manualPaymentSchema = z
  .object({
    amount: money,
    paidAt: z.coerce.date(),
    bankReference: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
export type ManualPaymentDto = z.infer<typeof manualPaymentSchema>;

export const importBankFileSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    content: z.string().min(1).max(5_000_000),
  })
  .strict();
export type ImportBankFileDto = z.infer<typeof importBankFileSchema>;
