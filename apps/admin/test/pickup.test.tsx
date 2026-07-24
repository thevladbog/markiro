import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PickupPage } from "../src/pages/pickup/index.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Undoes any `vi.spyOn(URL, ...)` from the export tests below -- without
  // this, `URL.createObjectURL`/`revokeObjectURL` stay mocked (and keep
  // their call history) across tests in this file, since they're spies on a
  // shared global, not scoped per-test the way `vi.stubGlobal("fetch", ...)`
  // is.
  vi.restoreAllMocks();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Minimal Response stand-in for the export endpoint, which reads `.text()`, not `.json()`. */
function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as Response;
}

/** Like `textResponse`, but with headers (so the download can read Content-Disposition). */
function textResponseWithHeaders(
  status: number,
  body: string,
  headers: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
  } as Response;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PickupPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ORDER_A = {
  id: "o1",
  orderNo: "37",
  employeeName: "Смирнов Алексей",
  kioskName: "Киоск-1",
  reason: "buy",
  writeoffReasonName: null,
  itemCount: 3,
  totalPrice: "178.00",
  status: "pending",
  createdAt: "2026-07-23T14:05:00.000Z",
};

const ORDER_B = {
  id: "o2",
  orderNo: "36",
  employeeName: "Гусева Наталья",
  kioskName: "Киоск-1",
  reason: "writeoff",
  writeoffReasonName: "Маркетинг",
  itemCount: 2,
  totalPrice: null,
  status: "punched",
  createdAt: "2026-07-23T12:40:00.000Z",
};

describe("PickupPage", () => {
  it("renders both orders from the mocked GET response in the table", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [ORDER_A, ORDER_B] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByText("Смирнов Алексей")).toBeDefined();
    expect(screen.getByText("Гусева Наталья")).toBeDefined();

    const table = within(screen.getByRole("table"));
    expect(table.getByText("37")).toBeDefined();
    expect(table.getByText("36")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/pickup-orders", expect.any(Object));
  });

  it("refetches with ?status=pending when the status filter changes to Ожидают", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [ORDER_A, ORDER_B] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смирнов Алексей");

    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "pending" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-orders?status=pending",
        expect.any(Object),
      );
    });
  });

  it("posts the selected order ids to /pickup-orders/export from the bulk-export toolbar", async () => {
    // jsdom doesn't implement `URL.createObjectURL` -- stub it (and its
    // counterpart) the same way `labels-editor.test.tsx`'s download tests do,
    // so `exportCodes`'s success path (Blob -> object URL -> anchor click)
    // can run without throwing, and so the download can be asserted on.
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/export") {
        return textResponse(200, "0104006381333931211234567890");
      }
      return jsonResponse(200, { items: [ORDER_A, ORDER_B] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Массовая выгрузка" }));

    const row = screen.getByText("37").closest("tr");
    if (!row) throw new Error("expected a table row for order 37");
    fireEvent.click(within(row).getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "Выгрузить коды" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-orders/export",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ orderIds: ["o1"] }),
        }),
      );
    });

    // The 200 response should trigger the actual download.
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalled();
    });
    expect(await screen.findByText("Коды выгружены")).toBeDefined();
  });

  it("names the downloaded file from the server's Content-Disposition header", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    // Capture every anchor the page creates; the export download is the only
    // one that sets a (non-empty) `download`, so it's unambiguous to find.
    const anchors: HTMLAnchorElement[] = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "a") anchors.push(el as HTMLAnchorElement);
      return el;
    });

    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/export") {
        return textResponseWithHeaders(200, "0104006381333931211234567890", {
          "Content-Disposition": 'attachment; filename="codes-20260724.txt"',
        });
      }
      return jsonResponse(200, { items: [ORDER_A, ORDER_B] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Массовая выгрузка" }));
    const row = screen.getByText("37").closest("tr");
    if (!row) throw new Error("expected a table row for order 37");
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Выгрузить коды" }));

    await waitFor(() => expect(anchors.some((a) => a.download)).toBe(true));
    expect(anchors.find((a) => a.download)?.download).toBe("codes-20260724.txt");
  });

  it("rejects the export mutation and does NOT trigger a download when the export endpoint responds with an HTTP error", async () => {
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/pickup-orders/export") {
        return textResponse(500, "<html>Internal Server Error</html>");
      }
      return jsonResponse(200, { items: [ORDER_A, ORDER_B] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Массовая выгрузка" }));

    const row = screen.getByText("37").closest("tr");
    if (!row) throw new Error("expected a table row for order 37");
    fireEvent.click(within(row).getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "Выгрузить коды" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-orders/export",
        expect.objectContaining({ method: "POST" }),
      );
    });

    // The mutation must reject on a non-ok response -- so the page's error
    // toast fires and (deterministically, independent of toast timing/state,
    // which `@markiro/ui`'s toast viewport keeps in a module-level singleton
    // that isn't reset between tests) no Blob/object-URL/download is ever
    // built.
    expect(await screen.findByText("Не удалось выгрузить коды")).toBeDefined();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it("disables the export button until at least one row is selected", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [ORDER_A, ORDER_B] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Смирнов Алексей");

    fireEvent.click(screen.getByRole("button", { name: "Массовая выгрузка" }));

    expect(screen.getByRole("button", { name: "Выгрузить коды" })).toHaveProperty("disabled", true);
  });

  it("shows an EmptyState (not a table) when there are no orders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage();

    expect(await screen.findByText("Заявок пока нет")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
