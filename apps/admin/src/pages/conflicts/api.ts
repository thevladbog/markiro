/**
 * Typed fetchers + TanStack Query hooks for the conflicts endpoints (Task
 * 06b-7: `GET /conflicts`, `POST /conflicts/:id/review`). Thin wrapper over
 * `../../api/client.ts`'s `apiFetch` -- see that module for the shared base
 * URL, credentials, and error-message parsing. Mirrors the shape of
 * `../shifts/api.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/conflicts/dto.ts`'s `ConflictDto`, `Date` fields as `string`. */
export interface ConflictDto {
  id: string;
  codeHash: string;
  losingShiftId: string;
  losingTerminalId: string | null;
  losingScannedAt: string;
  winningShiftId: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
  detectedAt: string;
  reviewedAt: string | null;
}

export interface ListConflictsParams {
  shiftId?: string;
  reviewed?: boolean;
}

interface ListConflictsResponse {
  items: ConflictDto[];
}

/** Shared TanStack Query cache key prefix for the conflicts list (all filter variants). */
export const CONFLICTS_QUERY_KEY = ["conflicts"] as const;

function conflictsQueryKey(params: ListConflictsParams) {
  return [...CONFLICTS_QUERY_KEY, params] as const;
}

function buildListPath(params: ListConflictsParams): string {
  const query = new URLSearchParams();
  if (params.shiftId) query.set("shiftId", params.shiftId);
  if (params.reviewed !== undefined) query.set("reviewed", String(params.reviewed));
  const qs = query.toString();
  return qs ? `/conflicts?${qs}` : "/conflicts";
}

async function fetchConflicts(params: ListConflictsParams): Promise<ConflictDto[]> {
  const response = await apiFetch<ListConflictsResponse>(buildListPath(params));
  return response.items;
}

function postReviewConflict(id: string): Promise<ConflictDto> {
  return apiFetch<ConflictDto>(`/conflicts/${id}/review`, { method: "POST" });
}

/** `GET /conflicts` -- the active tenant's conflicts, optionally filtered by shift/review status. */
export function useConflicts(params: ListConflictsParams = {}): UseQueryResult<ConflictDto[]> {
  return useQuery({
    queryKey: conflictsQueryKey(params),
    queryFn: () => fetchConflicts(params),
  });
}

/** `POST /conflicts/:id/review`. Invalidates every conflicts list query variant on success. */
export function useReviewConflict(): UseMutationResult<ConflictDto, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postReviewConflict,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONFLICTS_QUERY_KEY });
    },
  });
}
