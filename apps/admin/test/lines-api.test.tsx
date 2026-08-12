import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("line mutation hooks", () => {
  it("creates a line and invalidates its list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(CREATED_LINE));
    vi.stubGlobal("fetch", fetchMock);
    const { result, invalidateQueries } = renderLineMutationHook(() => useCreateLine());

    await act(() => result.current.mutateAsync({ name: "Розлив" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Розлив" }) }),
    );
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: LINES_QUERY_KEY }),
    );
  });

  it("updates a line and invalidates its list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(CREATED_LINE));
    vi.stubGlobal("fetch", fetchMock);
    const { result, invalidateQueries } = renderLineMutationHook(() => useUpdateLine());

    await act(() => result.current.mutateAsync({ id: "line-1", input: { name: "Розлив" } }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines/line-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Розлив" }) }),
    );
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: LINES_QUERY_KEY }),
    );
  });

  it("deletes a line and invalidates its list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, invalidateQueries } = renderLineMutationHook(() => useDeleteLine());

    await act(() => result.current.mutateAsync("line-1"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines/line-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: LINES_QUERY_KEY }),
    );
  });
});
