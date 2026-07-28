import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(table.getByText(UNREVIEWED.codeHash)).toBeDefined();
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

    await screen.findByText(REVIEWED.codeHash);
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
    await screen.findByText(UNREVIEWED.codeHash);

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
});
