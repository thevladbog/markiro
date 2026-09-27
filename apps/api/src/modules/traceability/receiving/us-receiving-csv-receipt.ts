import { isDeepStrictEqual } from "node:util";
import { ServiceUnavailableException } from "@nestjs/common";
import { receivingCsvReceiptSchema, type ReceivingCsvReceipt } from "@markiro/platform-contracts";
export type { ReceivingCsvReceipt } from "@markiro/platform-contracts";

export const csvApplyUnavailable = () =>
  new ServiceUnavailableException({ code: "receiving_csv_apply_unavailable" });
/** Validate immutable storage without normalizing or repairing its evidence. */
export function parseReceivingCsvReceipt(value: unknown): ReceivingCsvReceipt {
  const parsed = receivingCsvReceiptSchema.safeParse(value);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, value)) throw csvApplyUnavailable();
  return parsed.data;
}
