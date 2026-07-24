import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KiosksPage } from "../src/pages/kiosks/index.js";

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
      <KiosksPage />
    </QueryClientProvider>,
  );
}

// A few seconds in the past -- well within the ~2 minute online window, and
// not timing-flaky (see the task brief's note on avoiding a fixed clock).
const RECENT_LAST_SEEN = new Date(Date.now() - 5_000).toISOString();

const ONLINE_KIOSK = {
  id: "k1",
  name: "Касса у входа",
  location: "Зал 1",
  dayLimitPerEmployee: 5,
  showPrices: true,
  status: "active",
  lastSeenAt: RECENT_LAST_SEEN,
  enrolled: true,
  productIds: ["p1"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const OFFLINE_KIOSK = {
  id: "k2",
  name: "Склад",
  location: null,
  dayLimitPerEmployee: 3,
  showPrices: false,
  status: "active",
  lastSeenAt: null,
  enrolled: false,
  productIds: [],
  createdAt: "2026-01-02T00:00:00.000Z",
};

const PRODUCT_A = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  productGroup: "Молочные продукты",
  boxCapacity: 12,
  palletCapacity: 48,
  status: "active",
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PRODUCT_B = {
  id: "p2",
  gtin14: "04600000000018",
  name: "Сыр Российский",
  productGroup: "Молочные продукты",
  boxCapacity: 6,
  palletCapacity: 24,
  status: "active",
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  createdAt: "2026-01-02T00:00:00.000Z",
};

const REASON_A = { id: "r1", name: "Испорчен товар", sortOrder: 1 };

function stubFetch(overrides: {
  kiosks?: unknown[];
  products?: unknown[];
  reasons?: unknown[];
  onPost?: (path: string, init?: RequestInit) => Response | undefined;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const override = overrides.onPost?.(path, init);
    if (override) return override;
    if (path.startsWith("/api/kiosks")) {
      return jsonResponse(200, { items: overrides.kiosks ?? [] });
    }
    if (path.startsWith("/api/products")) {
      return jsonResponse(200, { items: overrides.products ?? [] });
    }
    if (path.startsWith("/api/pickup-reasons")) {
      return jsonResponse(200, { items: overrides.reasons ?? [] });
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("KiosksPage", () => {
  it("renders the kiosks list with online/offline status derived from lastSeenAt", async () => {
    stubFetch({ kiosks: [ONLINE_KIOSK, OFFLINE_KIOSK], products: [PRODUCT_A, PRODUCT_B] });

    renderPage();

    expect(await screen.findByText("Касса у входа")).toBeDefined();
    expect(screen.getByText("Склад")).toBeDefined();
    expect(screen.getByText("Зал 1")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined(); // OFFLINE_KIOSK.location is null
    expect(screen.getByText("В сети")).toBeDefined();
    expect(screen.getByText("Не в сети")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Да")).toBeDefined();
    expect(screen.getByText("Нет")).toBeDefined();
  });

  it("opens the create modal and POSTs /api/kiosks with the entered name", async () => {
    let didCreate = false;
    const created = { ...ONLINE_KIOSK, id: "k3", name: "Новый киоск" };
    const fetchMock = stubFetch({
      kiosks: [],
      onPost: (path, init) => {
        if (path === "/api/kiosks" && init?.method === "POST") {
          didCreate = true;
          return jsonResponse(201, created);
        }
        if (path.startsWith("/api/kiosks")) {
          return jsonResponse(200, { items: didCreate ? [created] : [] });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Киоски не добавлены");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить киоск" })[0]!);
    await screen.findByText("Новый киоск");

    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Название"), { target: { value: "Новый киоск" } });
    fireEvent.click(dialog.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const postCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/kiosks" && call[1]?.method === "POST",
    )!;
    const body = JSON.parse(postCall[1]?.body as string);
    expect(body.name).toBe("Новый киоск");
  });

  it('clicking "Выдать токен" POSTs /api/kiosks/:id/enroll and shows the one-time token in a modal', async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/enroll" && init?.method === "POST") {
          return jsonResponse(200, { token: "one-time-token-abc123" });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");

    fireEvent.click(screen.getByRole("button", { name: "Выдать токен" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks/k1/enroll",
        expect.objectContaining({ method: "POST" }),
      );
    });

    expect(await screen.findByText("one-time-token-abc123")).toBeDefined();
    expect(screen.getByText("Токен подключения киоска")).toBeDefined();
  });

  it("edits a kiosk and toggles the product allowlist, saving via PUT /api/kiosks/:id/products", async () => {
    const updated = { ...ONLINE_KIOSK, productIds: ["p1", "p2"] };
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      products: [PRODUCT_A, PRODUCT_B],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/products" && init?.method === "PUT") {
          return jsonResponse(200, updated);
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить киоск");

    const productBCheckbox = screen.getByLabelText(PRODUCT_B.name) as HTMLInputElement;
    expect(productBCheckbox.checked).toBe(false);
    const productACheckbox = screen.getByLabelText(PRODUCT_A.name) as HTMLInputElement;
    expect(productACheckbox.checked).toBe(true);

    fireEvent.click(productBCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить список" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks/k1/products",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ productIds: ["p1", "p2"] }),
        }),
      );
    });
  });

  it("archives a kiosk via the row action + confirm modal", async () => {
    let didArchive = false;
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1" && init?.method === "DELETE") {
          didArchive = true;
          return jsonResponse(204, undefined);
        }
        if (path.startsWith("/api/kiosks")) {
          return jsonResponse(200, { items: didArchive ? [] : [ONLINE_KIOSK] });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");

    fireEvent.click(screen.getByRole("button", { name: "В архив" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks/k1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("the embedded ReasonsEditor adds a reason via POST /api/pickup-reasons", async () => {
    let didCreate = false;
    const created = { id: "r2", name: "Брак упаковки", sortOrder: 2 };
    const fetchMock = stubFetch({
      kiosks: [],
      reasons: [REASON_A],
      onPost: (path, init) => {
        if (path === "/api/pickup-reasons" && init?.method === "POST") {
          didCreate = true;
          return jsonResponse(201, created);
        }
        if (path.startsWith("/api/pickup-reasons")) {
          return jsonResponse(200, { items: didCreate ? [REASON_A, created] : [REASON_A] });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByDisplayValue("Испорчен товар");

    const nameInputs = screen.getAllByLabelText("Название");
    // The existing reason's row renders its name as an input's *value*
    // (findByText won't match it) -- the reasons list has one existing row
    // plus the add row, so target the add row specifically by its
    // still-empty value.
    const addInput = nameInputs.find((el) => (el as HTMLInputElement).value === "")!;
    fireEvent.change(addInput, { target: { value: "Брак упаковки" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить причину" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-reasons",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Брак упаковки" }),
        }),
      );
    });
  });
});
