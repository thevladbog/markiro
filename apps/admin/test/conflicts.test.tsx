import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { formatScanTime } from "../src/lib/datetime.js";
import type * as ConflictsApiModule from "../src/pages/conflicts/api.js";
import { ConflictsPage } from "../src/pages/conflicts/index.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/conflicts/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ConflictsApiModule>();
  return {
    ...actual,
    useReviewConflict: () => {
      const counted = useRef(false);
      if (!counted.current) {
        writeHookMountSpy();
        counted.current = true;
      }
      return actual.useReviewConflict();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_WRITE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

function renderPage(access: AccessDocument = OPERATIONS_WRITE_ACCESS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <ConflictsPage />
      </AccessProvider>
    </QueryClientProvider>,
  );
}

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

// losingShiftId and winningShiftId are deliberately DISTINCT ("s1" vs "s2"):
// the shift column/filter reads losingShiftId only (see
// ConflictsService.listConflicts), and with both ids equal, a bug that read
// winningShiftId instead would still render the correct label and every
// assertion below would stay green.
const UNREVIEWED = {
  id: "c1",
  codeHash: "h1".padEnd(64, "0"),
  losingShiftId: "s1",
  losingTerminalId: "t1",
  losingScannedAt: "2026-07-28T10:00:00.000Z",
  winningShiftId: "s2",
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

const SECOND_UNREVIEWED = {
  ...UNREVIEWED,
  id: "c3",
  codeHash: "h3".padEnd(64, "0"),
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

// `createdAt` is overridden, not just `plannedDate`: the server orders shifts by
// `createdAt` ascending, so a fixture that left both timestamps equal would not
// actually model the oldest-first order the dropdown has to reverse.
const SHIFT_S2 = {
  ...SHIFT_S1,
  id: "s2",
  productName: "Sprite",
  plannedDate: "2026-07-29",
  createdAt: "2026-07-29T09:00:00.000Z",
};

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
  it("keeps conflict details readable while hiding review without operations.write", async () => {
    stubFetch({ conflicts: [UNREVIEWED], shifts: [SHIFT_S1] });

    renderPage(OPERATIONS_READ_ONLY);

    expect(
      (await screen.findByRole("table")).querySelector(`[title="${UNREVIEWED.codeHash}"]`),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Отметить рассмотренным" })).toBeNull();
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

  it("shares one review mutation observer across all writable rows", async () => {
    stubFetch({ conflicts: [UNREVIEWED, SECOND_UNREVIEWED], shifts: [SHIFT_S1] });

    renderPage();

    expect(await screen.findAllByRole("button", { name: "Отметить рассмотренным" })).toHaveLength(
      2,
    );
    expect(writeHookMountSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks every review action while the shared mutation is pending", async () => {
    const reviewResult = new Promise<Response>(() => {});
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/conflicts/c1/review" && init?.method === "POST") {
        return reviewResult;
      }
      if (path.startsWith("/api/conflicts")) {
        return jsonResponse(200, { items: [UNREVIEWED, SECOND_UNREVIEWED] });
      }
      return jsonResponse(200, { items: [SHIFT_S1] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const buttons = (await screen.findAllByRole("button", {
      name: "Отметить рассмотренным",
    })) as HTMLButtonElement[];
    fireEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url) === "/api/conflicts/c1/review" && init?.method === "POST",
        ),
      ).toHaveLength(1);
    });
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[1]!.disabled).toBe(true);
    expect(buttons[0]!.querySelector(".mk-spin")).not.toBeNull();
    expect(buttons[1]!.querySelector(".mk-spin")).toBeNull();

    fireEvent.click(buttons[1]!);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

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
    // Defaults to the unreviewed filter (see the test below dedicated to it).
    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts?reviewed=false", expect.any(Object));
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

  it("pins each terminal id to its own scan time cell, not the other column's", async () => {
    stubFetch({ conflicts: [UNREVIEWED] });

    renderPage();
    await screen.findByRole("table");

    // Looking values up anywhere in the table (as the test above does) stays
    // green even if the losing/winning columns -- or just their scan-time
    // spans -- were swapped between render functions, since both terminal
    // ids and both times would still be present *somewhere*. Scoping to the
    // specific <td> a terminal id renders in, and asserting its OWN scan
    // time lives in that same cell (and the other column's time does not),
    // is what actually pins the pairing.
    const losingTime = formatScanTime(UNREVIEWED.losingScannedAt, "ru");
    const winningTime = formatScanTime(UNREVIEWED.winningScannedAt, "ru");

    const losingCell = screen.getByText("t1").closest("td");
    const winningCell = screen.getByText("t2").closest("td");
    if (!losingCell || !winningCell) throw new Error("expected terminal id cells to render");

    expect(within(losingCell).getByText(losingTime)).toBeDefined();
    expect(within(losingCell).queryByText(winningTime)).toBeNull();
    expect(within(winningCell).getByText(winningTime)).toBeDefined();
    expect(within(winningCell).queryByText(losingTime)).toBeNull();
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

  it("lists the shift filter options newest first, though GET /shifts returns oldest first", async () => {
    const user = userEvent.setup();
    stubFetch({ conflicts: [UNREVIEWED], shifts: [SHIFT_S1, SHIFT_S2] });

    renderPage();
    await screen.findByRole("table");

    await user.click(screen.getByRole("combobox", { name: "Смена" }));
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent);
    // The mocked /api/shifts response lists SHIFT_S1 (older) before SHIFT_S2
    // (newer), matching the server's real oldest-first order -- the manager
    // currently closing the newest shift should not have to scroll to find
    // it in the dropdown.
    expect(optionLabels).toEqual(["Все смены", "2026-07-29 — Sprite", "2026-07-28 — Cola"]);
  });

  it("refetches the list scoped to the selected shift when the shift filter changes", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ conflicts: [UNREVIEWED], shifts: [SHIFT_S1, SHIFT_S2] });

    renderPage();
    await screen.findByRole("table");
    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts?reviewed=false", expect.any(Object));

    await chooseOption(user, "Смена", "2026-07-29 — Sprite");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/conflicts?shiftId=s2&reviewed=false",
        expect.any(Object),
      );
    });
  });

  // The bug this guards against: the list showed reviewed and unreviewed
  // conflicts together, forever, because the page never sent `reviewed` at
  // all -- "mark reviewed" changed a badge and nothing else. Defaulting to
  // unreviewed-only is what actually shrinks the list.
  it("defaults to the unreviewed filter, and the status toggle changes it", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ conflicts: [UNREVIEWED] });

    renderPage();
    await screen.findByRole("table");
    expect(fetchMock).toHaveBeenCalledWith("/api/conflicts?reviewed=false", expect.any(Object));

    await chooseOption(user, "Статус", "Рассмотренные");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/conflicts?reviewed=true", expect.any(Object));
    });

    await chooseOption(user, "Статус", "Все");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/conflicts", expect.any(Object));
    });
  });
});
