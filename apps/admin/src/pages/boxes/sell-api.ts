/**
 * Fetcher + hook for GET /boxes/sell-codes (sell-at-register view). Kept
 * separate from ./api.ts: this endpoint returns raw KM payloads and is
 * consumed only by SellBoxPage.
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/boxes/dto.ts`'s BoxSellCodesDto. */
export interface BoxSellCodeItemDto {
  codeHash: string;
  rawKm: string;
  gtin14: string;
  serial: string;
}

export interface BoxSellCodesDto {
  boxId: string;
  sscc: string;
  productName: string;
  itemCount: number;
  items: BoxSellCodeItemDto[];
}

export function useBoxSellCodes(sscc: string | undefined): UseQueryResult<BoxSellCodesDto> {
  return useQuery({
    queryKey: ["boxes", "sell-codes", sscc],
    queryFn: () =>
      apiFetch<BoxSellCodesDto>(`/boxes/sell-codes?${new URLSearchParams({ sscc: sscc! })}`),
    enabled: Boolean(sscc),
    // Коды короба не меняются, пока кассир листает; повторный запрос среди
    // показа только мешает (потеря сети — обычное дело у кассы).
    staleTime: Infinity,
    retry: false,
  });
}
