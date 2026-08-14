import type { ParsedKm } from "@markiro/domain";

const CRYPTO_AIS = ["91", "92", "93"] as const;

export interface KmPresentation {
  gtin14: string;
  serial: string;
  crypto: Array<{ ai: (typeof CRYPTO_AIS)[number]; value: string }>;
  normalized: string;
}

export function presentKm(km: ParsedKm): KmPresentation {
  const crypto = CRYPTO_AIS.flatMap((ai) => {
    const value = km.ais[ai];
    return value === undefined ? [] : [{ ai, value }];
  });
  return {
    gtin14: km.gtin14,
    serial: km.serial,
    crypto,
    normalized: [
      `(01)${km.gtin14}`,
      `(21)${km.serial}`,
      ...crypto.map(({ ai, value }) => `(${ai})${value}`),
    ].join(" "),
  };
}
