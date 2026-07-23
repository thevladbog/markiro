/**
 * Typed fetchers + TanStack Query hooks for the pickup-orders endpoints
 * (Task 4/9: `GET /pickup-orders`, `GET /pickup-orders/:id`,
 * `POST /pickup-orders/:id/resolve`, `POST /pickup-orders/:id/cancel`,
 * `POST /pickup-orders/export`). Thin wrapper over `../../api/client.ts`'s
 * `apiFetch` -- see that module for the shared base URL, credentials, and
 * error-message parsing. Mirrors the shape of `../shifts/api.ts` (Task 12) /
 * `../catalog/api.ts` for the filtered-list query key + `buildListPath`
 * pattern.
 *
 * `export` is the one endpoint that can't go through `apiFetch`: it responds
 * `text/plain` (a newline-delimited codes file), not JSON, so `useExportCodes`
 * calls `fetch` directly and triggers a browser download from the text body.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { apiFetch, ApiRequestError } from "../../api/client.js";

export type PickupOrderStatus = "pending" | "punched" | "writtenoff" | "cancelled";
export type PickupOrderReason = "buy" | "writeoff";

/** Mirrors `apps/api/src/modules/pickup-orders/dto.ts`'s `PickupOrderRowDto`. */
export interface PickupOrderRowDto {
  id: string;
  orderNo: string;
  employeeName: string;
  kioskName: string;
  reason: PickupOrderReason;
  writeoffReasonName: string | null;
  itemCount: number;
  totalPrice: string | null;
  status: PickupOrderStatus;
  createdAt: string;
}

/** Mirrors `apps/api/src/modules/pickup-orders/dto.ts`'s `PickupOrderItemDto`. */
export interface PickupOrderItemDto {
  id: string;
  gtin14: string;
  serial: string;
  rawKm: string;
  productName: string;
  unitPrice: string | null;
}

/** Mirrors `apps/api/src/modules/pickup-orders/dto.ts`'s `PickupOrderDetailDto`. */
export interface PickupOrderDetailDto extends PickupOrderRowDto {
  employeeBadgeCode: string | null;
  items: PickupOrderItemDto[];
  receiptNo: string | null;
  actNo: string | null;
}

export interface ListPickupOrdersParams {
  status?: PickupOrderStatus;
  reason?: PickupOrderReason;
  from?: string;
  to?: string;
}

export interface ResolveOrderInput {
  action: "punch" | "writeoff";
  receiptNo?: string;
  actNo?: string;
  writeoffReasonId?: string;
}

interface ListPickupOrdersResponse {
  items: PickupOrderRowDto[];
}

/** Shared TanStack Query cache key prefix for the pickup-orders list (all filter variants). */
export const PICKUP_ORDERS_QUERY_KEY = ["pickup-orders"] as const;

function pickupOrdersQueryKey(params: ListPickupOrdersParams) {
  return [...PICKUP_ORDERS_QUERY_KEY, params] as const;
}

/** Shared TanStack Query cache key prefix for a single pickup-order's detail view. */
export const PICKUP_ORDER_QUERY_KEY = ["pickup-order"] as const;

function pickupOrderQueryKey(id: string) {
  return [...PICKUP_ORDER_QUERY_KEY, id] as const;
}

function buildListPath(params: ListPickupOrdersParams): string {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.reason) query.set("reason", params.reason);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  const qs = query.toString();
  return qs ? `/pickup-orders?${qs}` : "/pickup-orders";
}

async function fetchPickupOrders(params: ListPickupOrdersParams): Promise<PickupOrderRowDto[]> {
  const response = await apiFetch<ListPickupOrdersResponse>(buildListPath(params));
  return response.items;
}

function fetchPickupOrder(id: string): Promise<PickupOrderDetailDto> {
  return apiFetch<PickupOrderDetailDto>(`/pickup-orders/${id}`);
}

function postResolveOrder(id: string, input: ResolveOrderInput): Promise<PickupOrderRowDto> {
  return apiFetch<PickupOrderRowDto>(`/pickup-orders/${id}/resolve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

function postCancelOrder(id: string): Promise<PickupOrderRowDto> {
  return apiFetch<PickupOrderRowDto>(`/pickup-orders/${id}/cancel`, { method: "POST" });
}

/** `GET /pickup-orders` -- the active tenant's pickup orders, optionally filtered. */
export function usePickupOrders(
  params: ListPickupOrdersParams = {},
): UseQueryResult<PickupOrderRowDto[]> {
  return useQuery({
    queryKey: pickupOrdersQueryKey(params),
    queryFn: () => fetchPickupOrders(params),
  });
}

/** `GET /pickup-orders/:id` -- a single order's detail view (items, receipt/act numbers). */
export function usePickupOrder(id: string): UseQueryResult<PickupOrderDetailDto> {
  return useQuery({
    queryKey: pickupOrderQueryKey(id),
    queryFn: () => fetchPickupOrder(id),
  });
}

/**
 * The count of pending orders, e.g. for a nav badge. Derived from
 * `usePickupOrders({ status: "pending" })` rather than its own endpoint --
 * returns 0 while the underlying query is loading (or has no data yet).
 */
export function usePendingOrderCount(): number {
  const { data } = usePickupOrders({ status: "pending" });
  return data?.length ?? 0;
}

/** `POST /pickup-orders/:id/resolve`. Invalidates every pickup-orders query variant on success. */
export function useResolveOrder(): UseMutationResult<
  PickupOrderRowDto,
  Error,
  { id: string; input: ResolveOrderInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => postResolveOrder(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_ORDERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PICKUP_ORDER_QUERY_KEY });
    },
  });
}

/** `POST /pickup-orders/:id/cancel`. Invalidates every pickup-orders query variant on success. */
export function useCancelOrder(): UseMutationResult<PickupOrderRowDto, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postCancelOrder,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PICKUP_ORDERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PICKUP_ORDER_QUERY_KEY });
    },
  });
}

/**
 * `POST /pickup-orders/export` -- returns a `text/plain` codes file, not
 * JSON, so this bypasses `apiFetch` and calls `fetch` directly, then triggers
 * a browser download of the response text. A non-`ok` response throws an
 * `ApiRequestError` (mirroring `apiFetch`'s own error handling) *before* the
 * body is read or a download is triggered, so a failed export rejects the
 * mutation instead of downloading an error page as `codes.txt`.
 */
async function exportCodes(orderIds: string[]): Promise<string> {
  const res = await fetch("/api/pickup-orders/export", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderIds }),
  });
  if (!res.ok) {
    throw new ApiRequestError(res.status, res.statusText || `HTTP ${res.status}`);
  }
  const text = await res.text();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "codes.txt";
  a.click();
  URL.revokeObjectURL(url);
  return text;
}

/** `POST /pickup-orders/export` -- downloads a codes.txt file for the given order IDs. */
export function useExportCodes(): UseMutationResult<string, Error, string[]> {
  return useMutation({ mutationFn: exportCodes });
}
