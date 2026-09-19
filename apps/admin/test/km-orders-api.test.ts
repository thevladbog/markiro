import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../src/api/client.js";
import {
  KM_ORDERS_QUERY_KEY,
  kmIssueFileUrl,
  kmOrderPreflightCodes,
  kmOrderQueryKey,
  kmOrderRefetchInterval,
  useCreateKmOrder,
  useIssueKmCodes,
  useKmOrders,
  useRetryKmOrder,
} from "../src/pages/km-orders/api.js";
import { KM_ORDER_STATES } from "../src/pages/km-orders/schemas.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const OMS_ORDER_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";

/** Mirrors `ChzKmOrderListItemDto` (apps/api/src/modules/chz-km-orders/dto.ts). */
function listItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    productId: PRODUCT_ID,
    productName: "Вода газированная 1,0 л",
    gtin14: "04680089900383",
    productGroupAlias: "water",
    templateId: 1,
    quantity: 5000,
    state: "completed",
    omsOrderId: OMS_ORDER_ID,
    bufferStatus: "ACTIVE",
    bufferExpiresAt: "2026-10-01T09:00:00.000Z",
    availableCodes: 0,
    fetchedCount: 5000,
    issuedCount: 1200,
    availableForIssue: 3800,
    rejectionReason: null,
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: "2026-09-18T09:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return { ...listItem(), issues: [], ...overrides };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    kind: "print",
    format: null,
    fromSeq: 1201,
    toSeq: 1400,
    count: 200,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: "2026-09-18T11:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("km orders api client", () => {
  it("posts a create request with the exact body and refreshes both cache keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(order(), 201));
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, wrapper } = createWrapper();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const hook = renderHook(() => useCreateKmOrder(), { wrapper });

    await hook.result.current.mutateAsync({
      productId: PRODUCT_ID,
      quantity: 5000,
      contactPerson: "Елена Ким",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/chz-km-orders");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      productId: PRODUCT_ID,
      quantity: 5000,
      contactPerson: "Елена Ким",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KM_ORDERS_QUERY_KEY });
  });

  it("omits an absent contact person instead of sending null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(order(), 201));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createWrapper();
    const hook = renderHook(() => useCreateKmOrder(), { wrapper });

    await hook.result.current.mutateAsync({ productId: PRODUCT_ID, quantity: 10 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ productId: PRODUCT_ID, quantity: 10 });
  });

  it("posts a print issue to the order's issues route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(issue(), 201));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createWrapper();
    const hook = renderHook(() => useIssueKmCodes(), { wrapper });

    await hook.result.current.mutateAsync({ orderId: ORDER_ID, kind: "print", count: 200 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/chz-km-orders/${ORDER_ID}/issues`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "print", count: 200 });
  });

  it("posts an export issue with its format", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(issue({ kind: "export", format: "csv" }), 201));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createWrapper();
    const hook = renderHook(() => useIssueKmCodes(), { wrapper });

    await hook.result.current.mutateAsync({
      orderId: ORDER_ID,
      kind: "export",
      format: "csv",
      count: 200,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ kind: "export", format: "csv", count: 200 });
  });

  it("retries a failed order through its own route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(order({ state: "signing" })));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createWrapper();
    const hook = renderHook(() => useRetryKmOrder(), { wrapper });

    await hook.result.current.mutateAsync(ORDER_ID);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/chz-km-orders/${ORDER_ID}/retry`);
    expect(init.method).toBe("POST");
  });

  it("unwraps the list envelope and caches it under the list key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ orders: [listItem()] })));
    const { queryClient, wrapper } = createWrapper();
    const hook = renderHook(() => useKmOrders(), { wrapper });

    await waitFor(() => expect(hook.result.current.data).toBeDefined());
    expect(hook.result.current.data).toHaveLength(1);
    expect(hook.result.current.data?.[0]?.availableForIssue).toBe(3800);
    expect(queryClient.getQueryData(KM_ORDERS_QUERY_KEY)).toBeDefined();
  });

  it("refuses a list row carrying a field the contract does not declare", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ orders: [listItem({ rawCode: "0104680…" })] })),
    );
    const { wrapper } = createWrapper();
    const hook = renderHook(() => useKmOrders(), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true));
  });

  it("refuses a state the client does not know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ orders: [listItem({ state: "archived" })] })),
    );
    const { wrapper } = createWrapper();
    const hook = renderHook(() => useKmOrders(), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true));
  });

  it("keys a single order by its identifier", () => {
    expect(kmOrderQueryKey(ORDER_ID)).toEqual([...KM_ORDERS_QUERY_KEY, ORDER_ID]);
  });

  it("builds the export download URL from encoded identifiers", () => {
    expect(kmIssueFileUrl(ORDER_ID, ISSUE_ID)).toBe(
      `/api/chz-km-orders/${ORDER_ID}/issues/${ISSUE_ID}/file`,
    );
    expect(kmIssueFileUrl("a/b", "c d")).toBe("/api/chz-km-orders/a%2Fb/issues/c%20d/file");
  });

  it("polls every five seconds until the order reaches a terminal state", () => {
    expect(kmOrderRefetchInterval(undefined)).toBe(5_000);
    for (const state of KM_ORDER_STATES) {
      const terminal = state === "completed" || state === "rejected" || state === "failed";
      expect(kmOrderRefetchInterval(state)).toBe(terminal ? false : 5_000);
    }
  });

  it("reads the preflight blockers out of a 422 and nothing else", () => {
    const blocked = new ApiRequestError(422, "Unprocessable", "CHZ_KM_ORDER_PREFLIGHT_FAILED", {
      code: "CHZ_KM_ORDER_PREFLIGHT_FAILED",
      blockedBy: ["AGENT_NOT_PAIRED", "PRODUCT_GTIN_MISSING"],
    });
    expect(kmOrderPreflightCodes(blocked)).toEqual(["AGENT_NOT_PAIRED", "PRODUCT_GTIN_MISSING"]);

    expect(kmOrderPreflightCodes(new ApiRequestError(403, "Forbidden"))).toBeNull();
    expect(kmOrderPreflightCodes(new Error("network"))).toBeNull();
    expect(
      kmOrderPreflightCodes(
        new ApiRequestError(422, "Unprocessable", "CHZ_KM_ORDER_PREFLIGHT_FAILED", {
          code: "CHZ_KM_ORDER_PREFLIGHT_FAILED",
          blockedBy: ["SOMETHING_NEW"],
        }),
      ),
    ).toBeNull();
  });
});
