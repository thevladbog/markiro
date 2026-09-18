/**
 * The org-wide pallet list client (warehouse pallets, plan 3 Task 1): the
 * request it builds from filters and the cursor it carries into the next page.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInfinitePallets, type PalletDto } from "../src/pages/shifts/pallets-api.js";
import { jsonResponse } from "./helpers/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const WAREHOUSE_PALLET: PalletDto = {
  id: "pal-w1",
  sscc: "00104600682000000019",
  kind: "warehouse",
  productId: "p1",
  productName: "Молоко 1л",
  deviceName: "ТСД-1",
  rejectedMembershipCount: 2,
  terminalId: "hh-1",
  lineName: null,
  operatorId: null,
  boxCount: 30,
  unitCount: 600,
  closedAt: "2026-09-17T10:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useInfinitePallets", () => {
  it("requests the org-wide list with only the set filters and pages by cursor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cursor=")) {
        return jsonResponse(200, { items: [{ ...WAREHOUSE_PALLET, id: "pal-w2" }] });
      }
      return jsonResponse(200, { items: [WAREHOUSE_PALLET], nextCursor: "abc" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () =>
        useInfinitePallets({
          kind: "warehouse",
          productId: "p1",
          closedFrom: "2026-09-01T00:00:00.000Z",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/pallets?kind=warehouse&productId=p1&closedFrom=2026-09-01T00%3A00%3A00.000Z&limit=100",
    );
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/pallets?kind=warehouse&productId=p1&closedFrom=2026-09-01T00%3A00%3A00.000Z&limit=100&cursor=abc",
    );
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.data?.pages.flatMap((page) => page.items).map((row) => row.id)).toEqual([
      "pal-w1",
      "pal-w2",
    ]);
  });
});
