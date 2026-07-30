/**
 * Typed fetcher + TanStack Query hook for the boxes endpoint (Task 14:
 * `GET /boxes?shiftId=`). Thin wrapper over `../../api/client.ts`'s
 * `apiFetch` -- see that module for the shared base URL, credentials, and
 * error-message parsing. Mirrors the shape of `../conflicts/api.ts`.
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/boxes/dto.ts`'s `BoxDto`, `Date` fields as `string`. */
export interface BoxDto {
  id: string;
  sscc: string | null;
  terminalId: string | null;
  operatorId: string | null;
  itemCount: number;
  closedAt: string | null;
  contentsChangedAfterClose: boolean;
}

interface ListBoxesResponse {
  items: BoxDto[];
}

/** Shared TanStack Query cache key prefix for the boxes list (all shift variants). */
export const BOXES_QUERY_KEY = ["boxes"] as const;

function buildListPath(shiftId: string): string {
  return `/boxes?${new URLSearchParams({ shiftId }).toString()}`;
}

async function fetchBoxes(shiftId: string): Promise<BoxDto[]> {
  const response = await apiFetch<ListBoxesResponse>(buildListPath(shiftId));
  return response.items;
}

/**
 * `GET /boxes?shiftId=`. Disabled (no request sent) while no shift is
 * selected -- unlike `/conflicts`, a box list is always scoped to one shift,
 * so there is no "all shifts" server query to fall back to.
 */
export function useBoxes(shiftId: string | undefined): UseQueryResult<BoxDto[]> {
  return useQuery({
    queryKey: [...BOXES_QUERY_KEY, shiftId],
    queryFn: () => fetchBoxes(shiftId!),
    enabled: Boolean(shiftId),
  });
}
