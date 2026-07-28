import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PickupPage } from "../src/pages/pickup/index.js";
import { RejectionsPage } from "../src/pages/pickup/Rejections.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const REJECTION = {
  id: "r-1",
  kind: "items_refused",
  kioskId: "k-1",
  kioskName: "Киоск-1",
  employeeName: "Иван Иванов",
  badgeCode: null,
  orderId: null,
  orderNo: null,
  deviceSeq: 10,
  codes: [{ rawKm: "0104600682000020215X", reason: "not_allowed" }],
  scannedAt: "2026-07-28T06:00:00.000Z",
  syncedAt: "2026-07-28T09:00:00.000Z",
  acknowledgedAt: null,
};

const UNKNOWN_BADGE_REJECTION = {
  ...REJECTION,
  id: "r-2",
  kind: "unknown_badge",
  employeeName: null,
  badgeCode: "badge-gone",
  deviceSeq: 12,
  codes: [{ rawKm: "0104600682000013215Y", reason: "unknown_badge" }],
};

function renderWith(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("rejections banner on the свод", () => {
  it("stays hidden when nothing is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("/pickup-rejections")
          ? jsonResponse(200, { items: [], openCount: 0 })
          : jsonResponse(200, { items: [] }),
      ),
    );

    renderWith(<PickupPage />);

    await waitFor(() => expect(screen.getByText("Заявок пока нет")).toBeDefined());
    expect(screen.queryByText(/Отклонённые сканы:/)).toBeNull();
  });

  it("shows the count and kiosks when something is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("/pickup-rejections")
          ? jsonResponse(200, { items: [REJECTION], openCount: 3 })
          : jsonResponse(200, { items: [] }),
      ),
    );

    renderWith(<PickupPage />);

    await waitFor(() => expect(screen.getByText("Отклонённые сканы: 3")).toBeDefined());
    expect(screen.getByText(/Киоск-1/)).toBeDefined();
  });
});

describe("rejections page", () => {
  it("lists a refused scan and reveals its codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [REJECTION], openCount: 1 })),
    );

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Иван Иванов")).toBeDefined());
    expect(screen.getByText("без заявки")).toBeDefined();
    expect(screen.queryByText(/0104600682000020215X/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Показать коды" }));

    expect(screen.getByText(/0104600682000020215X/)).toBeDefined();
    expect(screen.getByText(/товар недоступен на киоске/)).toBeDefined();
  });

  it("labels a scan whose badge was not recognised", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [UNKNOWN_BADGE_REJECTION], openCount: 1 })),
    );

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Бейдж не опознан")).toBeDefined());
    expect(screen.getByText("Бейдж: badge-gone")).toBeDefined();
  });

  it("acknowledges a rejection", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse(200, { ...REJECTION, acknowledgedAt: "2026-07-28T10:00:00.000Z" });
      }
      return jsonResponse(200, { items: [REJECTION], openCount: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Иван Иванов")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Отработано" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/pickup-rejections/r-1/acknowledge") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("shows the empty state when there is nothing to review", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [], openCount: 0 })),
    );

    renderWith(<RejectionsPage />);

    await waitFor(() => expect(screen.getByText("Отклонённых сканов нет")).toBeDefined());
  });
});

// `/pickup/rejections` must not be swallowed by `/pickup/:id`. React Router
// ranks the static segment above the dynamic one, but that ranking is a
// framework behaviour this page's URL now depends on, so assert it.
describe("routing", () => {
  it("resolves /pickup/rejections to the rejections page, not the order detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [], openCount: 0 })),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/pickup/rejections"]}>
          <Routes>
            <Route path="/pickup/rejections" element={<RejectionsPage />} />
            <Route path="/pickup/:id" element={<div>order detail</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("Отклонённые сканы")).toBeDefined());
    expect(screen.queryByText("order detail")).toBeNull();
  });
});
