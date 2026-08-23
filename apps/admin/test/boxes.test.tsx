import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatCreatedAt, formatDate } from "../src/lib/datetime.js";
import { BoxesPage } from "../src/pages/boxes/index.js";

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
      <MemoryRouter>
        <BoxesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const OPEN_BOX = {
  id: "b1",
  sscc: null,
  terminalId: null,
  operatorId: null,
  itemCount: 3,
  closedAt: null,
  contentsChangedAfterClose: false,
};

const CLOSED_BOX = {
  id: "b2",
  sscc: "00123456789012345675",
  terminalId: "t1",
  lineName: "Линия розлива № 1",
  operatorId: "emp1",
  itemCount: 2,
  closedAt: "2026-07-28T10:00:00.000Z",
  contentsChangedAfterClose: false,
};

// The exact scenario `contentsChangedAfterClose` exists for -- see
// apps/api/src/modules/boxes/dto.ts.
const SHORT_BOX = {
  ...CLOSED_BOX,
  id: "b3",
  itemCount: 1,
  contentsChangedAfterClose: true,
};

const EMPLOYEE = { id: "emp1", fullName: "Иван Иванов", role: null, status: "active", badges: [] };

// Minimal ShiftDto-shaped fixtures (only the fields the shift filter/label
// actually read) -- mirrors conflicts.test.tsx's SHIFT_S1/SHIFT_S2.
const SHIFT_S1 = {
  id: "s1",
  number: "JUL26-001",
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

// `createdAt` (not just `plannedDate`) is overridden: `GET /shifts` orders
// oldest-first by `createdAt`, and the page auto-selects the LAST entry of
// that order as "newest" -- a fixture that left both timestamps equal would
// not actually model that.
const SHIFT_S2 = {
  ...SHIFT_S1,
  id: "s2",
  number: "JUL26-002",
  productName: "Sprite",
  plannedDate: "2026-07-29",
  createdAt: "2026-07-29T09:00:00.000Z",
};

function stubFetch(handlers: { boxes?: unknown[]; shifts?: unknown[]; employees?: unknown[] }) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/api/boxes")) {
      return jsonResponse(200, { items: handlers.boxes ?? [] });
    }
    if (path.startsWith("/api/shifts")) {
      return jsonResponse(200, { items: handlers.shifts ?? [] });
    }
    if (path.startsWith("/api/employees")) {
      return jsonResponse(200, { items: handlers.employees ?? [] });
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("BoxesPage", () => {
  it("prompts to select a shift and sends no /boxes request when there are no shifts yet", async () => {
    const fetchMock = stubFetch({ shifts: [] });

    renderPage();

    expect(await screen.findByText("Выберите смену, чтобы увидеть её короба")).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/boxes"))).toBe(false);
  });

  it("auto-selects the newest shift (GET /shifts is oldest-first) and fetches its boxes", async () => {
    const fetchMock = stubFetch({ shifts: [SHIFT_S1, SHIFT_S2], boxes: [] });

    renderPage();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/boxes?shiftId=s2", expect.any(Object));
    });
  });

  it("renders a box's sscc, production line, resolved operator name, and item count", async () => {
    stubFetch({ shifts: [SHIFT_S1], boxes: [CLOSED_BOX], employees: [EMPLOYEE] });

    renderPage();
    const table = within(await screen.findByRole("table"));

    expect(table.getByText("(00)123456789012345675")).toBeDefined();
    expect(table.getByText("Линия розлива № 1")).toBeDefined();
    expect(table.getByText(EMPLOYEE.fullName)).toBeDefined();
    expect(table.getByText("2")).toBeDefined();
    expect(table.getByText(formatCreatedAt(CLOSED_BOX.closedAt, "ru"))).toBeDefined();
  });

  it("falls back to the raw operator id when no matching employee is found", async () => {
    stubFetch({ shifts: [SHIFT_S1], boxes: [CLOSED_BOX], employees: [] });

    renderPage();
    const table = within(await screen.findByRole("table"));

    expect(table.getByText("emp1")).toBeDefined();
  });

  it("renders an em dash for an open box's sscc, terminal, operator, and closed time", async () => {
    stubFetch({ shifts: [SHIFT_S1], boxes: [OPEN_BOX] });

    renderPage();
    const table = within(await screen.findByRole("table"));

    expect(table.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(table.getByText("3")).toBeDefined();
  });

  it("shows a warning badge only for a box whose contents changed after closing", async () => {
    stubFetch({ shifts: [SHIFT_S1], boxes: [CLOSED_BOX, SHORT_BOX], employees: [EMPLOYEE] });

    renderPage();
    await screen.findByRole("table");

    expect(screen.getByText("Изменилось после закрытия")).toBeDefined();
    // Only ONE of the two rows earns the badge -- this is the assertion a
    // query that flagged every box regardless of `closed_at`/`displaced_at`
    // would still pass without.
    expect(screen.getAllByText("Изменилось после закрытия")).toHaveLength(1);
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [SHIFT_S1] });
        if (path.startsWith("/api/employees")) return jsonResponse(200, { items: [] });
        // /api/boxes -- never resolves, so the query stays pending.
        return new Promise<Response>(() => {});
      }),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("В этой смене нет коробов")).toBeNull();
  });

  it("shows an error alert (not EmptyState) when the boxes request fails, e.g. an expired session (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [SHIFT_S1] });
        if (path.startsWith("/api/employees")) return jsonResponse(200, { items: [] });
        return jsonResponse(401, { message: "Unauthorized" });
      }),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("В этой смене нет коробов")).toBeNull();
  });

  it("shows the empty state when the selected shift has no boxes", async () => {
    stubFetch({ shifts: [SHIFT_S1], boxes: [] });

    renderPage();

    expect(await screen.findByText("В этой смене нет коробов")).toBeDefined();
  });

  it("refetches scoped to the selected shift when the shift filter changes", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ shifts: [SHIFT_S1, SHIFT_S2], boxes: [] });

    renderPage();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/boxes?shiftId=s2", expect.any(Object));
    });

    await user.click(screen.getByRole("combobox", { name: "Смена" }));
    await user.click(await screen.findByRole("option", { name: "JUL26-001 · 28.07.2026 — Cola" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/boxes?shiftId=s1", expect.any(Object));
    });
  });

  it("formats shift dates for the active locale and narrows shifts by a date search", async () => {
    const user = userEvent.setup();
    stubFetch({ shifts: [SHIFT_S1, SHIFT_S2], boxes: [] });

    renderPage();
    await user.click(screen.getByRole("combobox", { name: "Смена" }));
    await user.type(screen.getByRole("searchbox", { name: "Поиск смены" }), "29.07.2026");

    expect(screen.getByRole("option", { name: "JUL26-002 · 29.07.2026 — Sprite" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "JUL26-001 · 28.07.2026 — Cola" })).toBeNull();
    expect(formatDate(SHIFT_S1.plannedDate!, "ru")).toBe("28.07.2026");
  });
});
