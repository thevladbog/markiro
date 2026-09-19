/**
 * Typed fetchers and TanStack Query hooks for `GET|POST /chz-km-orders` and
 * its issue routes. Thin wrapper over `../../api/client.ts`'s `apiFetch` --
 * see that module for the shared base URL, credentials and error parsing.
 *
 * Every response is parsed through `./schemas.js` before it reaches a
 * component: these rows drive how many marking codes an operator hands to a
 * line, so a field the cabinet misreads is a production error, not a cosmetic
 * one.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

import { API_BASE, ApiRequestError, apiFetch } from "../../api/client.js";
import {
  isTerminalKmOrderState,
  kmIssueCodesSchema,
  kmIssueSchema,
  kmIssueTooManyFailureSchema,
  kmOrderListSchema,
  kmOrderPreflightFailureSchema,
  kmOrderSchema,
  type CreateKmOrderInput,
  type IssueKmCodesInput,
  type KmIssue,
  type KmIssueCode,
  type KmOrder,
  type KmOrderListItem,
  type KmOrderPreflightCode,
  type KmOrderState,
} from "./schemas.js";

export const KM_ORDERS_QUERY_KEY = ["km-orders"] as const;

export function kmOrderQueryKey(orderId: string) {
  return [...KM_ORDERS_QUERY_KEY, orderId] as const;
}

export function kmIssueCodesQueryKey(orderId: string, issueId: string) {
  return [...kmOrderQueryKey(orderId), "issues", issueId, "codes"] as const;
}

const ORDERS_PATH = "/chz-km-orders";

function orderPath(orderId: string): string {
  return `${ORDERS_PATH}/${encodeURIComponent(orderId)}`;
}

/**
 * The browser navigates to this URL directly (a download, not a fetch), so it
 * carries the `/api` prefix the query hooks get from `apiFetch`.
 */
export function kmIssueFileUrl(orderId: string, issueId: string): string {
  return `${API_BASE}${orderPath(orderId)}/issues/${encodeURIComponent(issueId)}/file`;
}

/**
 * The cabinet route that renders one issue for printing. Not an API URL: the
 * print page is a real route the office opens in its own tab (the codes are
 * fetched there by `useKmIssueCodes`), so it carries no `/api` prefix.
 */
export function kmIssuePrintPath(orderId: string, issueId: string): string {
  return `/km-orders/${encodeURIComponent(orderId)}/issues/${encodeURIComponent(issueId)}/print`;
}

async function listKmOrders(): Promise<KmOrderListItem[]> {
  return kmOrderListSchema.parse(await apiFetch<unknown>(ORDERS_PATH)).orders;
}

async function getKmOrder(orderId: string): Promise<KmOrder> {
  return kmOrderSchema.parse(await apiFetch<unknown>(orderPath(orderId)));
}

async function postKmOrder(input: CreateKmOrderInput): Promise<KmOrder> {
  const contactPerson = input.contactPerson?.trim();
  return kmOrderSchema.parse(
    await apiFetch<unknown>(ORDERS_PATH, {
      method: "POST",
      body: JSON.stringify({
        productId: input.productId,
        quantity: input.quantity,
        // Absent rather than null: the server's schema declares the field
        // optional, and an explicit null would fail its validation.
        ...(contactPerson ? { contactPerson } : {}),
      }),
    }),
  );
}

async function postKmOrderRetry(orderId: string): Promise<KmOrder> {
  return kmOrderSchema.parse(
    await apiFetch<unknown>(`${orderPath(orderId)}/retry`, { method: "POST" }),
  );
}

async function postKmIssue(input: IssueKmCodesInput): Promise<KmIssue> {
  const body =
    input.kind === "export"
      ? { kind: input.kind, format: input.format, count: input.count }
      : { kind: input.kind, count: input.count };
  return kmIssueSchema.parse(
    await apiFetch<unknown>(`${orderPath(input.orderId)}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

async function getKmIssueCodes(orderId: string, issueId: string): Promise<KmIssueCode[]> {
  const path = `${orderPath(orderId)}/issues/${encodeURIComponent(issueId)}/codes`;
  return kmIssueCodesSchema.parse(await apiFetch<unknown>(path)).codes;
}

/**
 * An order changes state in the background (signer round-trip, СУЗ buffer,
 * code fetch), so a card left open has to notice on its own. Terminal orders
 * stop polling: they cannot change again without an explicit action, which
 * invalidates the cache itself.
 */
export function kmOrderRefetchInterval(state: KmOrderState | undefined): number | false {
  return state !== undefined && isTerminalKmOrderState(state) ? false : 5_000;
}

/**
 * One call, not two: `kmOrderQueryKey(id)` and `kmIssueCodesQueryKey(id, …)`
 * both extend `KM_ORDERS_QUERY_KEY`, and `invalidateQueries` matches on key
 * PREFIX -- so invalidating the list already invalidates every card and every
 * code read under it.
 */
function invalidateKmOrders(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: KM_ORDERS_QUERY_KEY });
}

/**
 * Pulls the preflight blockers out of a refused create, or `null` when the
 * failure is anything else -- including a 422 naming a blocker this build does
 * not know, which the dialog reports as a generic refusal rather than as a
 * partial list of reasons (see `kmOrderPreflightFailureSchema`).
 */
export function kmOrderPreflightCodes(error: unknown): KmOrderPreflightCode[] | null {
  if (!(error instanceof ApiRequestError) || error.status !== 422) return null;
  const parsed = kmOrderPreflightFailureSchema.safeParse(error.details);
  return parsed.success ? parsed.data.blockedBy : null;
}

/**
 * How many codes the server says are still available, from a refused issue --
 * or `null` when the refusal is anything else (`CHZ_KM_ORDER_NOT_COMPLETED`,
 * `CHZ_KM_ISSUE_INCONSISTENT`, a transport failure), which the dialog reports
 * as a generic refusal rather than as a number it never received.
 */
export function kmIssueTooManyAvailable(error: unknown): number | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const parsed = kmIssueTooManyFailureSchema.safeParse(error.details);
  return parsed.success ? parsed.data.available : null;
}

/** `GET /chz-km-orders` -- the tenant's orders, newest first per the server. */
export function useKmOrders(): UseQueryResult<KmOrderListItem[]> {
  return useQuery({ queryKey: KM_ORDERS_QUERY_KEY, queryFn: listKmOrders });
}

/** `GET /chz-km-orders/:id` -- polls while the order is still in flight. */
export function useKmOrder(orderId: string): UseQueryResult<KmOrder> {
  return useQuery({
    queryKey: kmOrderQueryKey(orderId),
    queryFn: () => getKmOrder(orderId),
    refetchInterval: (query) => kmOrderRefetchInterval(query.state.data?.state),
  });
}

export function useCreateKmOrder(): UseMutationResult<KmOrder, Error, CreateKmOrderInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postKmOrder,
    onSuccess: () => invalidateKmOrders(queryClient),
  });
}

export function useRetryKmOrder(): UseMutationResult<KmOrder, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postKmOrderRetry,
    onSuccess: () => invalidateKmOrders(queryClient),
  });
}

/**
 * An issue permanently consumes a code range, so both the list (available
 * counts) and the card (issue history) are stale the moment it succeeds.
 */
export function useIssueKmCodes(): UseMutationResult<KmIssue, Error, IssueKmCodesInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postKmIssue,
    onSuccess: () => invalidateKmOrders(queryClient),
  });
}

/**
 * `GET /chz-km-orders/:id/issues/:issueId/codes` -- raw marking codes for the
 * print page. Never retained: the response is `no-store`, so the cache is
 * given a zero lifetime rather than keeping codes alive in memory behind the
 * page that asked for them.
 */
export function useKmIssueCodes(orderId: string, issueId: string): UseQueryResult<KmIssueCode[]> {
  return useQuery({
    queryKey: kmIssueCodesQueryKey(orderId, issueId),
    queryFn: () => getKmIssueCodes(orderId, issueId),
    staleTime: 0,
    gcTime: 0,
  });
}
