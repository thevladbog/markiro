import { UnprocessableEntityException } from "@nestjs/common";

export function requireProductGtin(gtin14: string | null): string {
  if (gtin14 === null) {
    throw new UnprocessableEntityException({ code: "GTIN_REQUIRED" });
  }
  return gtin14;
}
