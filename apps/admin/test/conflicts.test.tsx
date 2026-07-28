import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatScanTime } from "../src/lib/datetime.js";
import { ConflictsPage } from "../src/pages/conflicts/index.js";

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConflictsPage />
    </QueryClientProvider>,
  );
}

const UNREVIEWED = {
  id: "c1",
  codeHash: "h1".padEnd(64, "0"),
  losingShiftId: "s1",
  losingTerminalId: "t1",
  losingScannedAt: "2026-07-28T10:00:00.000Z",
  winningShiftId: "s1",
  winningTerminalId: "t2",
  winningScannedAt: "2026-07-28T10:00:05.000Z",
  detectedAt: "2026-07-28T10:00:06.000Z",
  reviewedAt: null,
};

const REVIEWED = {
  ...UNREVIEWED,
  id: "c2",
  codeHash: "h2".padEnd(64, "0"),
  reviewedAt: "2026-07-28T11:00:00.000Z",
};

/** Terminal ids are explicitly nullable -- this fixture exercises that case. */
const NULL_LOSING_TERMINAL = {
  ...UNREVIEWED,
  id: "c3",
  losingTerminalId: null,
};

// Minimal ShiftDto-shaped fixtures (only the fields the conflicts page's
// shift filter/column actually read) -- mirrors the shape of `../src/pages/shifts/api.ts`'s `ShiftDto`.
const SHIFT_S1 = {
  id: "s1",
  status: "active",
  mode: "validation",
  productId: "p1",
  productName: "Cola",
  lineId: null,
  lineName: null,
  counterpartyId: null,
  counterpartyName: null,
  labelTemplateId: null,
  labelTemplateName: null,
  plannedQty: null,
  plannedDate: "2026-07-28",
  boxCapacity: null,
  palletCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: null,
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-07-28T09:00:00.000Z",
};

const SHIFT_S2 = { ...SHIFT_S1, id: "s2", productName: "Sprite", plannedDate: "2026-07-29" };

function stubFetch(handlers: {
  conflicts?: unknown[];
  shifts?: unknown[];
  extra?: (url: string, init?: RequestInit) => Response | undefined;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const extra = handlers.extra?.(path, init);
    if (extra) return extra;
    if (path.startsWith("/api/conflicts")) {
      return jsonResponse(200, { items: handlers.conflicts ?? [] });
    }
    if (path.startsWith("/api/shifts")) {
      return jsonResponse(200, { items: handlers.shifts ?? [] });
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ConflictsPage", () => {
  it("renders conflicts from the mocked GET response with code, losing/winning terminals", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.startsWith("/api/conflicts")) return jsonResponse(200, { items: [UNREVIEWED] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const table = within(await screen.findByRole("table"));
    // codeHash is truncated for display (finding: a raw 64-char hash would
    // dominate the table) -- the full value survives in the cell's `title`.
    expect(table.getByTitle(UNREVIEWED.codeHash)).toBeDefined();
    expect(table.queryByText(UNREVIEWED.codeHash)).toBeNull();
    expect(table.getByText("t1")).toBeDefined();
    expect(table.getByText("t2")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts", expect.any(Object));
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Конфликтов нет")).toBeNull();
  });

  it("shows an error alert (not EmptyState) when the list request fails, e.g. an expired session (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Конфликтов нет")).toBeNull();
  });

  it("shows the empty state when there are no conflicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    renderPage();

    expect(await screen.findByText("Конфликтов нет")).toBeDefined();
  });

  it("shows a Reviewed badge instead of the review action for an already-reviewed conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.startsWith("/api/conflicts")) return jsonResponse(200, { items: [REVIEWED] });
        return jsonResponse(200, { items: [] });
      }),
    );

    renderPage();

    await screen.findByTitle(REVIEWED.codeHash);
    expect(screen.getByText("Рассмотрено")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Отметить рассмотренным" })).toBeNull();
  });

  it("POSTs /conflicts/:id/review on click and refreshes the list to show it reviewed", async () => {
    let reviewed = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/conflicts/c1/review" && init?.method === "POST") {
        reviewed = true;
        return jsonResponse(200, { ...UNREVIEWED, reviewedAt: "2026-07-28T12:00:00.000Z" });
      }
      if (path.startsWith("/api/conflicts")) {
        return jsonResponse(200, {
          items: [
            reviewed ? { ...UNREVIEWED, reviewedAt: "2026-07-28T12:00:00.000Z" } : UNREVIEWED,
          ],
        });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByTitle(UNREVIEWED.codeHash);

    fireEvent.click(screen.getByRole("button", { name: "Отметить рассмотренным" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/conflicts/c1/review",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(await screen.findByText("Рассмотрено")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Отметить рассмотренным" })).toBeNull();
  });

  it("renders the losing and winning scan times at second precision so seconds-apart scans read differently", async () => {
    stubFetch({ conflicts: [UNREVIEWED] });

    renderPage();
    const table = within(await screen.findByRole("table"));

    // UNREVIEWED's losing/winning scans are 5 seconds apart -- the shared
    // minute-precision `formatCreatedAt` would render both identically,
    // which is exactly the bug this test guards against.
    const losingTime = formatScanTime(UNREVIEWED.losingScannedAt, "ru");
    const winningTime = formatScanTime(UNREVIEWED.winningScannedAt, "ru");
    expect(losingTime).not.toBe(winningTime);
    expect(table.getByText(losingTime)).toBeDefined();
    expect(table.getByText(winningTime)).toBeDefined();
  });

  it("renders an em dash, not a blank cell, when the losing terminal id is null", async () => {
    stubFetch({ conflicts: [NULL_LOSING_TERMINAL] });

    renderPage();
    const table = within(await screen.findByRole("table"));

    expect(await table.findByText("—")).toBeDefined();
  });

  it("renders a shift column attributing the row to its losing shift", async () => {
    stubFetch({ conflicts: [UNREVIEWED], shifts: [SHIFT_S1, SHIFT_S2] });

    renderPage();
    const table = within(await screen.findByRole("table"));

    // UNREVIEWED.losingShiftId is "s1" -- SHIFT_S1's product/date, not SHIFT_S2's.
    expect(table.getByText("2026-07-28 — Cola")).toBeDefined();
    expect(table.queryByText("2026-07-29 — Sprite")).toBeNull();
  });

  it("refetches the list scoped to the selected shift when the shift filter changes", async () => {
    const fetchMock = stubFetch({ conflicts: [UNREVIEWED], shifts: [SHIFT_S1, SHIFT_S2] });

    renderPage();
    await screen.findByRole("table");
    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts", expect.any(Object));

    fireEvent.change(screen.getByLabelText("Смена"), { target: { value: "s2" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/conflicts?shiftId=s2", expect.any(Object));
    });
  });
});
