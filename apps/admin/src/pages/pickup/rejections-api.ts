/**
 * Typed fetchers + TanStack Query hooks for `GET /pickup-rejections` and
 * `POST /pickup-rejections/:id/acknowledge`. Kept out of `./api.ts` (already
 * ~250 lines covering the orders endpoints) so each file stays readable.
 * Same `apiFetch` wrapper and filtered-list query-key pattern as `./api.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/pickup-rejections/dto.ts`'s `ScanRejectionReason`. */
export type ScanRejectionReason =
  | "not_km"
  | "incomplete"
  | "unknown_product"
  | "not_allowed"
  | "duplicate"
  | "over_limit"
  | "unknown_badge";

export interface ScanRejectionCode {
  rawKm: string;
  reason: ScanRejectionReason;
}

/** Mirrors `apps/api/src/modules/pickup-rejections/dto.ts`'s `PickupScanRejectionRowDto`. */
export interface PickupScanRejectionRowDto {
  id: string;
  kind: "items_refused" | "unknown_badge";
  kioskId: string;
  kioskName: string;
  employeeName: string | null;
  badgeCode: string | null;
  orderId: string | null;
  orderNo: string | null;
  deviceSeq: number;
  codes: ScanRejectionCode[];
  scannedAt: string;
  syncedAt: string;
  acknowledgedAt: string | null;
}

export type RejectionState = "open" | "acknowledged" | "all";

export interface ListRejectionsParams {
  kioskId?: string;
  from?: string;
  to?: string;
  state?: RejectionState;
}

export interface ListRejectionsResponse {
  items: PickupScanRejectionRowDto[];
  openCount: number;
}

/** Shared cache key prefix for every rejections list variant. */
export const PICKUP_REJECTIONS_QUERY_KEY = ["pickup-rejections"] as const;

function rejectionsQueryKey(params: ListRejectionsParams) {
  return [...PICKUP_REJECTIONS_QUERY_KEY, params] as const;
}

function buildListPath(params: ListRejectionsParams): string {
  const query = new URLSearchParams();
  if (params.kioskId) query.set("kioskId", params.kioskId);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.state) query.set("state", params.state);
  const qs = query.toString();
  return qs ? `/pickup-rejections?${qs}` : "/pickup-rejections";
}

function fetchRejections(params: ListRejectionsParams): Promise<ListRejectionsResponse> {
  return apiFetch<ListRejectionsResponse>(buildListPath(params));
}

function postAcknowledge(id: string): Promise<PickupScanRejectionRowDto> {
  return apiFetch<PickupScanRejectionRowDto>(`/pickup-rejections/${id}/acknowledge`, {
    method: "POST",
  });
}

/** `GET /pickup-rejections` -- the tenant's refused scans, optionally filtered. */
export function usePickupRejections(
  params: ListRejectionsParams = {},
): UseQueryResult<ListRejectionsResponse> {
  return useQuery({
    queryKey: rejectionsQueryKey(params),
    queryFn: () => fetchRejections(params),
  });
}

/**
 * Feeds the свод banner: the count of unacknowledged rejections plus the
 * kiosks they came from. `openCount` is the server's global figure, so the
 * banner never disagrees with itself as filters change on the page.
 */
export function useOpenRejectionSummary(): { openCount: number; kioskNames: string[] } {
  const { data } = usePickupRejections({ state: "open" });
  const kioskNames = [...new Set((data?.items ?? []).map((row) => row.kioskName))].filter(Boolean);
  return { openCount: data?.openCount ?? 0, kioskNames };
}

/** `POST /pickup-rejections/:id/acknowledge`. Invalidates every rejections query variant. */
export function useAcknowledgeRejection(): UseMutationResult<
  PickupScanRejectionRowDto,
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postAcknowledge,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_REJECTIONS_QUERY_KEY });
    },
  });
}
