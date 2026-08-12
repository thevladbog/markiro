import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_ACCESS_QUERY_KEY } from "../src/access/api.js";
import {
  LINES_QUERY_KEY,
  useCreateLine,
  useDeleteLine,
  useUpdateLine,
} from "../src/pages/shifts/api.js";

const CREATED_LINE = { id: "line-1", name: "Розлив", createdAt: "2026-08-12T10:00:00.000Z" };

function renderLineMutationHook<T>(useLineMutation: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { ...renderHook(useLineMutation, { wrapper }), invalidateQueries };
}

function successfulJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pendingInvalidation(invalidateQueries: ReturnType<typeof vi.fn>) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  invalidateQueries.mockReturnValue(promise);
  return { resolve };
}

function pendingLineAndAccessInvalidations(invalidateQueries: ReturnType<typeof vi.fn>) {
  let resolveLines!: () => void;
  let resolveAccess!: () => void;
  const lines = new Promise<void>((done) => {
    resolveLines = done;
  });
  const access = new Promise<void>((done) => {
    resolveAccess = done;
  });
  invalidateQueries.mockImplementation(({ queryKey }: { queryKey: readonly string[] }) =>
    queryKey === LINES_QUERY_KEY ? lines : access,
  );
  return { resolveLines, resolveAccess };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("line mutation hooks", () => {
  it("creates a line and awaits line and cabinet-usage invalidation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(CREATED_LINE));
    vi.stubGlobal("fetch", fetchMock);
    const { result, invalidateQueries } = renderLineMutationHook(() => useCreateLine());
    const invalidation = pendingLineAndAccessInvalidations(invalidateQueries);

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.mutateAsync({ name: "Розлив" });
    });

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledTimes(2));
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: LINES_QUERY_KEY });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: CABINET_ACCESS_QUERY_KEY });
    expect(result.current.isPending).toBe(true);

    invalidation.resolveLines();
    await act(async () => Promise.resolve());
    expect(result.current.isPending).toBe(true);
    invalidation.resolveAccess();
    await act(() => mutation);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Розлив" }) }),
    );
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("updates a line without invalidating quota usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(CREATED_LINE));
    vi.stubGlobal("fetch", fetchMock);
    const { result, invalidateQueries } = renderLineMutationHook(() => useUpdateLine());
    const invalidation = pendingInvalidation(invalidateQueries);

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.mutateAsync({ id: "line-1", input: { name: "Розлив" } });
    });

    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: LINES_QUERY_KEY }),
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: CABINET_ACCESS_QUERY_KEY });
    expect(result.current.isPending).toBe(true);

    invalidation.resolve();
    await act(() => mutation);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines/line-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Розлив" }) }),
    );
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("deletes a line without a body and awaits line and cabinet-usage invalidation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, invalidateQueries } = renderLineMutationHook(() => useDeleteLine());
    const invalidation = pendingLineAndAccessInvalidations(invalidateQueries);

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = result.current.mutateAsync("line-1");
    });

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledTimes(2));
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: LINES_QUERY_KEY });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: CABINET_ACCESS_QUERY_KEY });
    expect(result.current.isPending).toBe(true);

    invalidation.resolveLines();
    await act(async () => Promise.resolve());
    expect(result.current.isPending).toBe(true);
    invalidation.resolveAccess();
    await act(() => mutation);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines/line-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    const deleteInit = fetchMock.mock.calls.find(([path]) => path === "/api/lines/line-1")?.[1] as
      RequestInit | undefined;
    expect(deleteInit).not.toHaveProperty("body");
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});
