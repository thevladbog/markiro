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

export function useBoxSellCodes(
  sscc: string | undefined,
  attempt = 0,
): UseQueryResult<BoxSellCodesDto> {
  return useQuery({
    // `attempt` is in the key so a cashier re-submitting the SAME SSCC after
    // a failed fetch (e.g. a transient network drop) forces a refetch --
    // otherwise the key is unchanged, `staleTime: Infinity` means React
    // Query considers the cached (errored) result still fresh, and
    // `retry: false` means it never retries on its own either.
    queryKey: ["boxes", "sell-codes", sscc, attempt],
    queryFn: () =>
      apiFetch<BoxSellCodesDto>(`/boxes/sell-codes?${new URLSearchParams({ sscc: sscc! })}`),
    enabled: Boolean(sscc),
    // Коды короба не меняются, пока кассир листает; повторный запрос среди
    // показа только мешает (потеря сети — обычное дело у кассы).
    staleTime: Infinity,
    retry: false,
  });
}
