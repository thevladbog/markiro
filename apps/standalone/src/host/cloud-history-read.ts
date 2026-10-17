import { z } from "zod";
import {
  cloudHistoryShiftSchema,
  cloudHistoryBoxSchema,
  cloudHistoryPalletSchema,
} from "./cloud-history.js";

/** Provenance sentinel only; it never identifies a local device record. */
export const CLOUD_HISTORY_DEVICE_ID = "00000000-0000-0000-0000-000000000000";

export const cloudShiftCardSchema = z.strictObject({
  sourceTimeZone: z.string(),
  shift: cloudHistoryShiftSchema,
  codeCount: z.number().int().nonnegative(),
  boxCount: z.number().int().nonnegative(),
  palletCount: z.number().int().nonnegative(),
  lateDataAt: z.iso.datetime({ offset: true }).nullable(),
});
export const cloudShiftPageSchema = z.strictObject({
  items: z.array(cloudShiftCardSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageCount: z.number().int().positive(),
});
export const cloudBoxCardSchema = z.strictObject({
  sourceTimeZone: z.string(),
  pack: cloudHistoryBoxSchema,
  shiftNumber: z.string(),
  productName: z.string().nullable(),
  productionDate: z.iso.date().nullable(),
  units: z.number().int().nonnegative(),
});
export const cloudPalletRowsSchema = z.strictObject({
  pallet: cloudHistoryPalletSchema,
  organization: z.strictObject({
    name: z.string(),
    inn: z.string().nullable(),
    timeZone: z.string(),
  }),
  boxes: z.array(cloudBoxCardSchema),
});
export type CloudShiftCard = z.infer<typeof cloudShiftCardSchema>;
export type CloudShiftPage = z.infer<typeof cloudShiftPageSchema>;
export type CloudBoxCard = z.infer<typeof cloudBoxCardSchema>;
export type CloudPalletRows = z.infer<typeof cloudPalletRowsSchema>;
