import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { filenameFromContentDisposition, usePickupOrders } from "../src/pages/pickup/api.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const ORDER = {
  id: "o1",
  orderNo: "PO-0001",
  employeeName: "Иванов Иван",
  kioskName: "Касса самовывоза 1",
  reason: "buy",
  writeoffReasonName: null,
  itemCount: 3,
  totalPrice: "150.00",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function Probe() {
  const { data } = usePickupOrders({ status: "pending" });
  return <p>{data?.[0]?.orderNo ?? "none"}</p>;
}

function renderProbe() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("filenameFromContentDisposition", () => {
  it("falls back to codes.txt when the header is absent", () => {
    expect(filenameFromContentDisposition(null)).toBe("codes.txt");
  });

  it("reads a plain quoted filename", () => {
    expect(filenameFromContentDisposition('attachment; filename="codes-20260724.txt"')).toBe(
      "codes-20260724.txt",
    );
  });

  it("decodes an RFC 5987 filename* with a non-empty language tag", () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8'ru'codes.txt")).toBe(
      "codes.txt",
    );
  });

  it("percent-decodes an RFC 5987 filename* value", () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''codes%2Dexport.txt")).toBe(
      "codes-export.txt",
    );
  });
});

describe("usePickupOrders", () => {
  it("surfaces the order row from GET /pickup-orders?status=pending", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [ORDER] }));
    vi.stubGlobal("fetch", fetchMock);

    renderProbe();

    expect(await screen.findByText("PO-0001")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/pickup-orders?status=pending", expect.any(Object));
  });
});
