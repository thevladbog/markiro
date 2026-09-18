/**
 * Typed fetchers + TanStack Query hooks for `GET /pallets`. Thin wrapper over
 * `../../api/client.ts`'s `apiFetch` -- see that module for the shared base
 * URL, credentials, and error-message parsing.
 *
 * Two consumers, two hooks:
 * - `usePallets(shiftId)` is the shift panel's list (06d): the WHOLE shift,
 *   no paging -- the server sends no `LIMIT` when `shiftId` is given without
 *   `limit`, precisely so this reader keeps seeing every pallet.
 * - `useInfinitePallets(filters)` is the org-wide registry (warehouse pallets,
 *   plan 3): a keyset page of `PALLET_LIST_PAGE_SIZE` rows at a time, in the
 *   server's `closed_at DESC NULLS FIRST, id ASC` order, continued with the
 *   `nextCursor` the server issued. The cursor is opaque here.
 *
 * ONE DIFFERENCE FROM THE BOX CLIENT, and it matters for error handling:
 * `GET /pallets` 404s for a `shiftId` that does not exist or belongs to
 * another tenant (`PalletsService.listPallets`), where `GET /boxes` returns
 * an empty list instead. A caller must therefore treat the error state as a
 * real failure to report, not as "this shift has no pallets".
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

export type PalletKind = "production" | "warehouse";

/** Mirrors `apps/api/src/modules/pallets/dto.ts`'s `PalletDto`, `Date` fields as `string`. */
export interface PalletDto {
  id: string;
  /** 20-значный код с GS1 AI "00" (требование Честного знака); в БД хранится голый 18-значный SSCC. */
  sscc: string | null;
  /** `warehouse` is built on a handheld from closed boxes of arbitrary shifts. */
  kind: PalletKind;
  /** A warehouse pallet's own product; a production pallet's through its shift. */
  productId: string | null;
  productName: string | null;
  /** Name of the station/handheld that reported this pallet, when resolvable. */
  deviceName: string | null;
  /** Memberships the server refused for this pallet; always 0 for a production one. */
  rejectedMembershipCount: number;
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

/** `GET /pallets` response; `nextCursor` is absent on the last page and on an unpaged shift list. */
export interface ListPalletsResponse {
  items: PalletDto[];
  nextCursor?: string;
}

/** Org-wide registry filters; every field maps 1:1 onto a `GET /pallets` query parameter. */
export interface PalletListFilters {
  kind?: PalletKind;
  productId?: string;
  deviceId?: string;
  /** ISO instant, inclusive lower bound on `closedAt`. */
  closedFrom?: string;
  /** ISO instant, inclusive upper bound on `closedAt`. */
  closedTo?: string;
}

/** The server's own default; its ceiling is 500. */
export const PALLET_LIST_PAGE_SIZE = 100;

/** Shared TanStack Query cache key prefix for the pallets list (all variants). */
export const PALLETS_QUERY_KEY = ["pallets"] as const;

function buildListPath(shiftId: string): string {
  return `/pallets?${new URLSearchParams({ shiftId }).toString()}`;
}

function buildRegistryPath(filters: PalletListFilters, cursor: string | undefined): string {
  const query = new URLSearchParams();
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.productId) query.set("productId", filters.productId);
  if (filters.deviceId) query.set("deviceId", filters.deviceId);
  if (filters.closedFrom) query.set("closedFrom", filters.closedFrom);
  if (filters.closedTo) query.set("closedTo", filters.closedTo);
  query.set("limit", String(PALLET_LIST_PAGE_SIZE));
  if (cursor) query.set("cursor", cursor);
  return `/pallets?${query.toString()}`;
}

async function fetchPallets(shiftId: string): Promise<PalletDto[]> {
  const response = await apiFetch<ListPalletsResponse>(buildListPath(shiftId));
  return response.items;
}

function fetchPalletPage(
  filters: PalletListFilters,
  cursor: string | undefined,
): Promise<ListPalletsResponse> {
  return apiFetch<ListPalletsResponse>(buildRegistryPath(filters, cursor));
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

/**
 * Org-wide `GET /pallets` with keyset paging. `filters` is part of the cache
 * key, so changing any filter starts a fresh first page rather than appending
 * to the previous list.
 */
export function useInfinitePallets(filters: PalletListFilters) {
  return useInfiniteQuery({
    queryKey: [...PALLETS_QUERY_KEY, "registry", filters] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchPalletPage(filters, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
