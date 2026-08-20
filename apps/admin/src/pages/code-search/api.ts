/**
 * Typed fetchers + TanStack Query hooks for the code-search endpoints
 * (Task 7: `GET /code-search`, `GET /code-search/codes`,
 * `GET /code-search/codes/:codeHash`, `GET /code-search/boxes/:boxId`).
 * Thin wrapper over `../../api/client.ts`'s `apiFetch` -- see that module
 * for the shared base URL, credentials, and error-message parsing. Mirrors
 * the shape of `../disaggregation/api.ts` (Task 9).
 *
 * Names/signatures here are a contract Task 12 (code/box card pages) reuses
 * verbatim -- see the task-11 brief's Interfaces block. `CodeCardDto`/
 * `BoxCardDto` mirror `apps/api/src/modules/code-search/dto.ts`'s wire
 * shapes with `Date` fields narrowed to `string` (JSON has no Date type).
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { ApiRequestError, apiFetch } from "../../api/client.js";

export type CodeStatus = "free" | "aggregated" | "written_off";

/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `CodeListItemDto`, `Date` fields as `string`. */
export interface CodeListItemDto {
  codeHash: string;
  gtin14: string;
  serial: string;
  productId: string | null;
  productName: string | null;
  status: CodeStatus;
  scannedAt: string;
  boxId: string | null;
  boxSscc: string | null;
}

interface ListCodesResponse {
  items: CodeListItemDto[];
  page: number;
  pageCount: number;
  total: number;
}

export interface ListCodesFilters {
  page: number;
  from?: string;
  to?: string;
  productId?: string;
  status?: string;
}

/** `GET /code-search` response: which entity the input resolved to. */
export type ClassifySearchResult =
  { type: "box"; boxId: string } | { type: "code"; codeHash: string };

/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `CodeHistoryEvent`, `Date` fields as `string`. */
export type CodeHistoryEvent =
  | {
      type: "scanned";
      at: string;
      verdict: string;
      shiftId: string;
      terminalId: string | null;
      operatorId: string | null;
    }
  | { type: "box_added"; at: string; boxId: string; boxSscc: string | null }
  | { type: "box_displaced"; at: string; boxId: string; boxSscc: string | null }
  | { type: "box_removed"; at: string; boxId: string; boxSscc: string | null }
  | {
      type: "box_disassembled";
      at: string;
      boxId: string;
      boxSscc: string | null;
      reason: string | null;
      disaggregationDocumentId: string | null;
      disaggregationDocNo: string | null;
    }
  | { type: "pickup_locked"; at: string; orderId: string; orderNo: string }
  | {
      type: "pickup_resolved";
      at: string;
      orderId: string;
      orderNo: string;
      orderStatus: "punched" | "writtenoff" | "cancelled";
    };

/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `CodeCardDto`, `Date` fields as `string`. */
export interface CodeCardDto {
  codeHash: string;
  gtin14: string;
  serial: string;
  productId: string | null;
  productName: string | null;
  status: CodeStatus;
  currentBox: { id: string; sscc: string | null } | null;
  history: CodeHistoryEvent[];
}

/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `BoxCardItemDto`, `Date` fields as `string`. */
export interface BoxCardItemDto {
  codeHash: string;
  gtin14: string | null;
  serial: string | null;
  addedAt: string;
  displacedAt: string | null;
  removedAt: string | null;
}

/** Mirrors `apps/api/src/modules/code-search/dto.ts`'s `BoxCardDto`, `Date` fields as `string`. */
export interface BoxCardDto {
  id: string;
  sscc: string | null;
  status: "open" | "closed" | "disassembled";
  shiftId: string;
  productId: string | null;
  productName: string | null;
  terminalId: string | null;
  operatorId: string | null;
  openedAt: string;
  closedAt: string | null;
  disassembledAt: string | null;
  items: BoxCardItemDto[];
  exceptions: {
    kind: string;
    reason: string | null;
    occurredAt: string;
    operatorId: string | null;
    disaggregationDocumentId: string | null;
    disaggregationDocNo: string | null;
  }[];
  pickupOrders: { orderId: string; orderNo: string; status: string }[];
}

/** Shared TanStack Query cache key prefix for code-search queries (all variants). */
export const CODE_SEARCH_QUERY_KEY = ["code-search"] as const;

function buildListPath(filters: ListCodesFilters): string {
  const query = new URLSearchParams();
  query.set("page", String(filters.page));
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.productId) query.set("productId", filters.productId);
  if (filters.status) query.set("status", filters.status);
  return `/code-search/codes?${query.toString()}`;
}

async function fetchCodes(filters: ListCodesFilters): Promise<ListCodesResponse> {
  return apiFetch<ListCodesResponse>(buildListPath(filters));
}

async function fetchCodeCard(codeHash: string): Promise<CodeCardDto> {
  return apiFetch<CodeCardDto>(`/code-search/codes/${codeHash}`);
}

async function fetchBoxCard(boxId: string): Promise<BoxCardDto> {
  return apiFetch<BoxCardDto>(`/code-search/boxes/${boxId}`);
}

/**
 * `GET /code-search?q=` -- classifies a scanned/typed SSCC or KM to a box or
 * a code. Throws `ApiRequestError` with `.code` `"unrecognized"` (not a
 * recognized SSCC/KM shape at all) or `"not_found"` (well-formed, but
 * nothing in this tenant matches) on 404 -- callers key their inline error
 * off `error.code` rather than `error.message`.
 */
export async function classifySearch(q: string): Promise<ClassifySearchResult> {
  const query = new URLSearchParams({ q });
  return apiFetch<ClassifySearchResult>(`/code-search?${query.toString()}`);
}

/** `GET /code-search/codes` -- the active tenant's code registry, filtered/paged. */
export function useCodes(filters: ListCodesFilters): UseQueryResult<ListCodesResponse> {
  return useQuery({
    queryKey: [...CODE_SEARCH_QUERY_KEY, "codes", filters],
    queryFn: () => fetchCodes(filters),
  });
}

/** `GET /code-search/codes/:codeHash`. Disabled (no request sent) while no codeHash is given. */
export function useCodeCard(codeHash: string | undefined): UseQueryResult<CodeCardDto> {
  return useQuery({
    queryKey: [...CODE_SEARCH_QUERY_KEY, "code", codeHash],
    queryFn: () => fetchCodeCard(codeHash!),
    enabled: Boolean(codeHash),
  });
}

/** `GET /code-search/boxes/:boxId`. Disabled (no request sent) while no boxId is given. */
export function useBoxCard(boxId: string | undefined): UseQueryResult<BoxCardDto> {
  return useQuery({
    queryKey: [...CODE_SEARCH_QUERY_KEY, "box", boxId],
    queryFn: () => fetchBoxCard(boxId!),
    enabled: Boolean(boxId),
  });
}

export { ApiRequestError };
