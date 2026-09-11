import { BadRequestException } from "@nestjs/common";

/** PostgreSQL numeric(14,2); check calculated amounts before writing money columns. */
export const MAX_COMMERCIAL_MINOR = 99_999_999_999_999n;

export function assertCommercialMoneyRange(...amounts: readonly bigint[]): void {
  if (amounts.some((amount) => amount < 0n || amount > MAX_COMMERCIAL_MINOR)) {
    throw new BadRequestException({ code: "commercial_amount_out_of_range" });
  }
}
