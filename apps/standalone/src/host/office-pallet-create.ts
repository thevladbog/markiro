import { z } from "zod";

export const PALLET_CODE_ERRORS = [
  "invalid_sscc",
  "not_box",
  "duplicate",
  "not_found",
  "not_closed",
  "disassembled",
  "already_on_pallet",
  "product_mismatch",
  "demo_box",
] as const;
export const palletCodeErrorSchema = z.object({
  line: z.number().int().positive(),
  code: z.enum(PALLET_CODE_ERRORS),
  sscc: z.string().nullable(),
  palletId: z.string().nullable(),
  palletKind: z.enum(["production", "warehouse"]).optional(),
});
export type PalletCodeError = z.infer<typeof palletCodeErrorSchema>;
export const palletValidationSchema = z.object({
  valid: z.boolean(),
  productId: z.string().nullable(),
  productName: z.string().nullable(),
  boxes: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
  errors: z.array(palletCodeErrorSchema),
});
export type PalletValidation = z.infer<typeof palletValidationSchema>;
export const palletValidateRequestSchema = z.object({ codes: z.array(z.string()) }).strict();
export const palletCreateRequestSchema = z
  .object({ requestId: z.uuid(), codes: z.array(z.string()) })
  .strict();
export type PalletCreateRequest = z.infer<typeof palletCreateRequestSchema>;
export const palletCreatedSchema = z.object({ id: z.uuid(), sscc: z.string().regex(/^\d{18}$/u) });
export type PalletCreated = z.infer<typeof palletCreatedSchema>;

export const officeWarehousePalletDetailSchema = z.object({
  id: z.uuid(),
  demo: z.boolean().default(false),
  sscc: z.string().nullable(),
  source: z.enum(["device", "cabinet"]),
  createdByName: z.string().nullable(),
  deviceName: z.string(),
  productId: z.uuid(),
  productName: z.string(),
  gtin14: z.string(),
  shelfLifeDays: z.number().int().nullable(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  disassembledAt: z.string().nullable(),
  boxes: z.number().int(),
  units: z.number().int(),
  organization: z.object({ name: z.string(), inn: z.string().nullable(), timeZone: z.string() }),
  members: z.array(
    z.object({
      membershipId: z.string(),
      id: z.string(),
      sscc: z.string().nullable(),
      shiftId: z.string(),
      shiftNumber: z.string(),
      productionDate: z.string(),
      units: z.number().int(),
      disassembledAt: z.string().nullable(),
      removedAt: z.string().nullable(),
    }),
  ),
});
export type OfficeWarehousePalletDetail = z.infer<typeof officeWarehousePalletDetailSchema>;
