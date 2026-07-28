import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KiosksPage } from "../src/pages/kiosks/index.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

/**
 * Mirrors `TTL_MS` in `apps/api/src/modules/kiosk/pairing.service.ts` -- the
 * stub has to hand back the same 15-minute window the real endpoint does, so
 * the countdown assertions below reflect production behaviour.
 */
const PAIRING_TTL_MS = 15 * 60_000;

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

const ARCHIVED_KIOSK = {
  ...OFFLINE_KIOSK,
  id: "k9",
  name: "Архивный киоск",
  status: "archived",
  enrolled: true,
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

  it('clicking "Код привязки" POSTs /api/kiosks/:id/pairing-code and reveals the code once', async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/pairing-code" && init?.method === "POST") {
          return jsonResponse(201, {
            code: "12345678",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");

    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks/k1/pairing-code",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const dialog = within(await screen.findByRole("dialog"));
    // Grouped for readability per design brief 07 §"States & constraints".
    expect(dialog.getByText("1234 5678")).toBeDefined();
    expect(screen.getByText("Код привязки киоска")).toBeDefined();

    // Copying hands over the bare digits -- the display grouping is presentation
    // only, and a space pasted into the kiosk's numeric keypad would not match.
    fireEvent.click(dialog.getByRole("button", { name: "Скопировать" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("12345678");
  });

  it("renders the pairing code as a scannable barcode", async () => {
    stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/pairing-code" && init?.method === "POST") {
          return jsonResponse(201, {
            code: "12345678",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");
    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));

    // The barcode is lazy-loaded (bwip-js stays out of the main bundle), so it
    // resolves well after the dialog itself: the dynamic import has to fetch
    // and evaluate a ~1 MB chunk, measured at ~300ms even on an idle dev
    // machine. Testing Library's default 1000ms wait left too thin a margin and
    // timed out on CI's 2-core runner under parallel workers, so this one query
    // gets an explicit budget (same escape hatch as `shifts.test.tsx`). Kept
    // under vitest's 5000ms per-test default, which would otherwise fire first
    // and turn a slow import into a less legible test-level timeout.
    const barcode = await screen.findByRole("img", { name: /12345678/ }, { timeout: 3000 });
    await waitFor(() => expect(barcode.querySelector("svg")).not.toBeNull());
  });

  it("counts the TTL down and drops into an expired state once it elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/pairing-code" && init?.method === "POST") {
          return jsonResponse(201, {
            code: "12345678",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");
    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Действителен ещё 15:00")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(dialog.getByText("Действителен ещё 14:00")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAIRING_TTL_MS);
    });
    expect(dialog.getByText("Срок действия кода истёк. Сформируйте новый код.")).toBeDefined();
    expect(dialog.queryByText("1234 5678")).toBeNull();
  });

  it("regenerates the code, replacing the revealed one with the freshly issued code", async () => {
    let issued = 0;
    const codes = ["12345678", "87654321"];
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/pairing-code" && init?.method === "POST") {
          const code = codes[issued++]!;
          return jsonResponse(201, {
            code,
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");
    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));

    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText("1234 5678");

    fireEvent.click(dialog.getByRole("button", { name: "Сформировать новый" }));

    expect(await dialog.findByText("8765 4321")).toBeDefined();
    expect(dialog.queryByText("1234 5678")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        (call) => call[0] === "/api/kiosks/k1/pairing-code" && call[1]?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("closing the modal discards the code so it can never be revealed twice", async () => {
    stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/pairing-code" && init?.method === "POST") {
          return jsonResponse(201, {
            code: "12345678",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");
    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("1234 5678");
    fireEvent.click(within(dialog).getByRole("button", { name: "Готово" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("1234 5678")).toBeNull();
  });

  it("no longer offers the raw-token enroll action", async () => {
    stubFetch({ kiosks: [ONLINE_KIOSK], products: [] });

    renderPage();
    await screen.findByText("Касса у входа");

    // Pairing replaced enrollment outright: the cabinet must not expose a
    // second provisioning path that reveals a device token in plaintext.
    expect(screen.queryByRole("button", { name: "Выдать токен" })).toBeNull();
  });

  it("hides the pairing and archive row actions for an archived kiosk", async () => {
    stubFetch({ kiosks: [ARCHIVED_KIOSK], products: [] });

    renderPage();
    await screen.findByText("Архивный киоск");

    // Both lifecycle actions are meaningless once archived -- only Edit remains.
    expect(screen.queryByRole("button", { name: "Код привязки" })).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeDefined();
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

  it("keeps the original sort order when a reason's sort-order input is cleared (does not persist 0)", async () => {
    const fetchMock = stubFetch({
      kiosks: [],
      reasons: [REASON_A], // sortOrder: 1
      onPost: (path, init) => {
        if (path === "/api/pickup-reasons/r1" && init?.method === "PATCH") {
          return jsonResponse(200, { ...REASON_A });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByDisplayValue("Испорчен товар");

    fireEvent.change(screen.getByLabelText("Порядок"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/pickup-reasons/r1",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/pickup-reasons/r1" && call[1]?.method === "PATCH",
    )!;
    const body = JSON.parse(patchCall[1]?.body as string);
    // Number("") === 0 passes the finite guard; a blank input must fall back to
    // the reason's existing order, not silently persist 0.
    expect(body.sortOrder).toBe(1);
  });
});
