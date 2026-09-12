/**
 * Typed fetcher + TanStack Query hook for the pallets endpoint (06d:
 * `GET /pallets?shiftId=`). Thin wrapper over `../../api/client.ts`'s
 * `apiFetch` -- see that module for the shared base URL, credentials, and
 * error-message parsing. Deliberately a near-copy of `../boxes/api.ts`: a
 * pallet list, like a box list, only ever makes sense scoped to one shift.
 *
 * ONE DIFFERENCE FROM THE BOX CLIENT, and it matters for error handling:
 * `GET /pallets` 404s for a shift that does not exist or belongs to another
 * tenant (`PalletsService.listPallets`), where `GET /boxes` returns an empty
 * list instead. A caller must therefore treat the error state as a real
 * failure to report, not as "this shift has no pallets".
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/pallets/dto.ts`'s `PalletDto`, `Date` fields as `string`. */
export interface PalletDto {
  id: string;
  /** 20-значный код с GS1 AI "00" (требование Честного знака); в БД хранится голый 18-значный SSCC. */
  sscc: string | null;
  terminalId: string | null;
  /** Assigned production line of the station that reported this pallet. */
  lineName: string | null;
  operatorId: string | null;
  /** Member boxes that are closed and not disassembled. */
  boxCount: number;
  /** Live items across those member boxes -- a disassembled box's items are off the stack too. */
  unitCount: number;
  closedAt: string | null;
  /** A member box was disassembled after this pallet closed: it is short a box it can no longer correct. */
  contentsChangedAfterClose: boolean;
  disassembledAt: string | null;
}

interface ListPalletsResponse {
  items: PalletDto[];
}

/** Shared TanStack Query cache key prefix for the pallets list (all shift variants). */
export const PALLETS_QUERY_KEY = ["pallets"] as const;

function buildListPath(shiftId: string): string {
  return `/pallets?${new URLSearchParams({ shiftId }).toString()}`;
}

async function fetchPallets(shiftId: string): Promise<PalletDto[]> {
  const response = await apiFetch<ListPalletsResponse>(buildListPath(shiftId));
  return response.items;
}

/**
 * `GET /pallets?shiftId=`. Disabled (no request sent) while no shift is
 * selected, and callers should also leave it disabled for a shift that never
 * enabled pallets -- the answer is known to be empty, and asking anyway
 * spends a request per panel open on every non-pallet shift in the plant.
 */
export function usePallets(shiftId: string | undefined): UseQueryResult<PalletDto[]> {
  return useQuery({
    queryKey: [...PALLETS_QUERY_KEY, shiftId],
    queryFn: () => fetchPallets(shiftId!),
    enabled: Boolean(shiftId),
  });
}
