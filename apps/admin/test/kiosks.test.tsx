import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as KiosksApiModule from "../src/pages/kiosks/api.js";
import { KiosksPage } from "../src/pages/kiosks/index.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/kiosks/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KiosksApiModule>();
  return {
    ...actual,
    useCreateKiosk: () => {
      writeHookMountSpy("create-kiosk");
      return actual.useCreateKiosk();
    },
    useUpdateKiosk: () => {
      writeHookMountSpy("update-kiosk");
      return actual.useUpdateKiosk();
    },
    useArchiveKiosk: () => {
      writeHookMountSpy("archive-kiosk");
      return actual.useArchiveKiosk();
    },
    useSetKioskProducts: () => {
      writeHookMountSpy("set-products");
      return actual.useSetKioskProducts();
    },
    useCreateReason: () => {
      writeHookMountSpy("create-reason");
      return actual.useCreateReason();
    },
    useUpdateReason: () => {
      writeHookMountSpy("update-reason");
      return actual.useUpdateReason();
    },
    useArchiveReason: () => {
      writeHookMountSpy("archive-reason");
      return actual.useArchiveReason();
    },
  };
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.INTEGRATIONS_READ,
    CABINET_CAPABILITY.INTEGRATIONS_WRITE,
    CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const MANAGER_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_READ_CREDENTIALS_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.CREDENTIALS_MANAGE],
};

function renderPage(access: AccessDocument = ADMIN_ACCESS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <KiosksPage />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
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
  onPost?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
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
  it("keeps kiosk rows readable while hiding operational mutations without operations.write", async () => {
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      products: [PRODUCT_A],
      reasons: [REASON_A],
    });

    renderPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(ONLINE_KIOSK.name)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить киоск" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    expect(screen.getByText(REASON_A.name)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить причину" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/pickup-reasons")),
    ).toBe(true);
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

  it("keeps pairing independently available with credentials.manage", async () => {
    stubFetch({ kiosks: [ONLINE_KIOSK], products: [PRODUCT_A] });

    renderPage(OPERATIONS_READ_CREDENTIALS_ACCESS);

    expect(await screen.findByText(ONLINE_KIOSK.name)).toBeDefined();
    expect(screen.getByRole("button", { name: "Код привязки" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
  });

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

  it("clears a legacy kiosk pairing secret from local state and the mutation cache on close or route teardown", async () => {
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) =>
        path === "/api/kiosks/k1/pairing-code" && init?.method === "POST"
          ? jsonResponse(201, {
              code: "12345678",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            })
          : undefined,
    });
    const { queryClient, unmount } = renderPage();
    await screen.findByText("Касса у входа");
    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));
    await screen.findByText("1234 5678");
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .some((mutation) => JSON.stringify(mutation.state.data).includes("12345678")),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    await waitFor(() => expect(screen.queryByText("1234 5678")).toBeNull());
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => !JSON.stringify(mutation.state.data).includes("12345678")),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));
    await screen.findByText("1234 5678");
    unmount();
    expect(screen.queryByText("1234 5678")).toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => !JSON.stringify(mutation.state.data).includes("12345678")),
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("pairing-code"))).toBe(true);
  });

  it("hides pairing from managers while keeping operational kiosk management visible", async () => {
    const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK], products: [PRODUCT_A] });

    renderPage(MANAGER_ACCESS);
    await screen.findByText("Касса у входа");

    expect(screen.queryByRole("button", { name: "Код привязки" })).toBeNull();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeDefined();
    expect(screen.getByRole("button", { name: "В архив" })).toBeDefined();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/pairing-code"))).toBe(
      false,
    );
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

    // bwip-js emits an `<svg>` with a `viewBox` but no width/height, which
    // collapses to 0x0 inside the panel's fit-content column flex -- the box
    // has to stay pinned for the symbol to be visible at all, and to match the
    // placeholder that held its place. jsdom cannot lay this out, so the guard
    // is on the declared size rather than a measured one.
    expect(barcode.style.width).toBe("158px");
    expect(barcode.style.height).toBe("74px");
  });

  it("does not reveal a pairing code that is already expired", async () => {
    stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path, init) => {
        if (path === "/api/kiosks/k1/pairing-code" && init?.method === "POST") {
          return jsonResponse(201, {
            code: "12345678",
            expiresAt: new Date(Date.now() - 1).toISOString(),
          });
        }
        return undefined;
      },
    });

    renderPage();
    await screen.findByText("Касса у входа");
    fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));

    const dialog = within(await screen.findByRole("dialog"));
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

  describe("pairing lifecycle response safety", () => {
    it("ignores a late regeneration success after close while the page stays mounted", async () => {
      let resolveRegeneration: ((response: Response) => void) | undefined;
      let issued = 0;
      const clipboard = { writeText: vi.fn() };
      const print = vi.fn();
      vi.stubGlobal("navigator", { clipboard });
      vi.stubGlobal("print", print);
      stubFetch({
        kiosks: [ONLINE_KIOSK],
        onPost: (path, init) => {
          if (path !== "/api/kiosks/k1/pairing-code" || init?.method !== "POST") return undefined;
          issued += 1;
          if (issued === 1)
            return jsonResponse(201, {
              code: "12345678",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            });
          return new Promise<Response>((resolve) => {
            resolveRegeneration = resolve;
          });
        },
      });
      const { queryClient } = renderPage();

      await screen.findByText("Касса у входа");
      fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));
      await screen.findByText("1234 5678");
      fireEvent.click(screen.getByRole("button", { name: "Сформировать новый" }));
      await waitFor(() => expect(resolveRegeneration).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
      const successCount = screen.queryAllByText("Код привязки сформирован").length;

      await act(async () => {
        resolveRegeneration?.(
          jsonResponse(201, {
            code: "87654321",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByText("8765 4321")).toBeNull();
      expect(screen.queryAllByText("Код привязки сформирован")).toHaveLength(successCount);
      expect(clipboard.writeText).not.toHaveBeenCalled();
      expect(print).not.toHaveBeenCalled();
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .every((mutation) => !JSON.stringify(mutation.state.data).includes("87654321")),
      ).toBe(true);
    });

    it("ignores a late regeneration error after close without showing a toast", async () => {
      let rejectRegeneration: ((error: Error) => void) | undefined;
      let issued = 0;
      stubFetch({
        kiosks: [ONLINE_KIOSK],
        onPost: (path, init) => {
          if (path !== "/api/kiosks/k1/pairing-code" || init?.method !== "POST") return undefined;
          issued += 1;
          if (issued === 1)
            return jsonResponse(201, {
              code: "12345678",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            });
          return new Promise<Response>((_resolve, reject) => {
            rejectRegeneration = reject;
          });
        },
      });
      renderPage();

      await screen.findByText("Касса у входа");
      fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));
      await screen.findByText("1234 5678");
      fireEvent.click(screen.getByRole("button", { name: "Сформировать новый" }));
      await waitFor(() => expect(rejectRegeneration).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: "Готово" }));
      const errorCount = screen.queryAllByText("Не удалось сформировать код привязки").length;

      await act(async () => {
        rejectRegeneration?.(new Error("late network failure"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryAllByText("Не удалось сформировать код привязки")).toHaveLength(
        errorCount,
      );
      expect(screen.queryByRole("dialog", { name: "Код привязки киоска" })).toBeNull();
    });

    it("keeps only the newest response when pairing requests overlap", async () => {
      const pending: Array<(response: Response) => void> = [];
      stubFetch({
        kiosks: [ONLINE_KIOSK],
        onPost: (path, init) => {
          if (path !== "/api/kiosks/k1/pairing-code" || init?.method !== "POST") return undefined;
          return new Promise<Response>((resolve) => pending.push(resolve));
        },
      });
      const { queryClient } = renderPage();

      await screen.findByText("Касса у входа");
      const action = screen.getByRole("button", { name: "Код привязки" });
      fireEvent.click(action);
      fireEvent.click(action);
      await waitFor(() => expect(pending).toHaveLength(2));
      const successCount = screen.queryAllByText("Код привязки сформирован").length;

      await act(async () => {
        pending[1]?.(
          jsonResponse(201, {
            code: "22222222",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(await screen.findByText("2222 2222")).toBeDefined();

      await act(async () => {
        pending[0]?.(
          jsonResponse(201, {
            code: "11111111",
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText("2222 2222")).toBeDefined();
      expect(screen.queryByText("1111 1111")).toBeNull();
      expect(screen.queryAllByText("Код привязки сформирован")).toHaveLength(successCount + 1);
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .every((mutation) => !JSON.stringify(mutation.state.data).includes("11111111")),
      ).toBe(true);
    });

    it("ignores a late regeneration response after Done and route teardown", async () => {
      let resolveRegeneration: ((response: Response) => void) | undefined;
      let regenerationSettled = false;
      let unmounted = false;
      let issued = 0;
      stubFetch({
        kiosks: [ONLINE_KIOSK],
        onPost: (path, init) => {
          if (path !== "/api/kiosks/k1/pairing-code" || init?.method !== "POST") return undefined;
          issued += 1;
          if (issued === 1)
            return jsonResponse(201, {
              code: "12345678",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            });
          return new Promise<Response>((resolve) => {
            resolveRegeneration = resolve;
          });
        },
      });
      const { queryClient, unmount } = renderPage();
      const settleRegeneration = async () => {
        await act(async () => {
          resolveRegeneration?.(
            jsonResponse(201, {
              code: "87654321",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            }),
          );
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
        regenerationSettled = true;
      };

      try {
        await screen.findByText("Касса у входа");
        fireEvent.click(screen.getByRole("button", { name: "Код привязки" }));
        await screen.findByText("1234 5678");
        await screen.findByRole("img", { name: /12345678/ }, { timeout: 3000 });
        fireEvent.click(screen.getByRole("button", { name: "Сформировать новый" }));
        fireEvent.click(screen.getByRole("button", { name: "Готово" }));
        unmount();
        unmounted = true;

        await settleRegeneration();
        expect(screen.queryByText("8765 4321")).toBeNull();
        expect(
          queryClient
            .getMutationCache()
            .getAll()
            .every((mutation) => !JSON.stringify(mutation.state.data).includes("87654321")),
        ).toBe(true);
      } finally {
        if (!unmounted) unmount();
        if (!regenerationSettled && resolveRegeneration) await settleRegeneration();
        queryClient.clear();
      }
    });

    it("clears only the dismissed kiosk's pairing response", async () => {
      stubFetch({
        kiosks: [ONLINE_KIOSK, OFFLINE_KIOSK],
        onPost: (path, init) => {
          if (init?.method !== "POST") return undefined;
          if (path === "/api/kiosks/k1/pairing-code") {
            return jsonResponse(201, {
              code: "11111111",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            });
          }
          if (path === "/api/kiosks/k2/pairing-code") {
            return jsonResponse(201, {
              code: "22222222",
              expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            });
          }
          return undefined;
        },
      });

      const { queryClient } = renderPage();
      await screen.findByText("Касса у входа");
      await screen.findByText("Склад");
      const pairingActions = screen.getAllByRole("button", { name: "Код привязки" });
      fireEvent.click(pairingActions[0]!);
      await screen.findByText("1111 1111");
      fireEvent.click(pairingActions[1]!);
      await screen.findByText("2222 2222");

      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => JSON.stringify(mutation.state.data).includes("11111111")),
      ).toBe(true);
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => JSON.stringify(mutation.state.data).includes("22222222")),
      ).toBe(true);

      const firstDialog = screen.getAllByRole("dialog", { name: "Код привязки киоска" })[0]!;
      fireEvent.click(within(firstDialog).getByRole("button", { name: "Готово" }));
      await waitFor(() => expect(screen.queryByText("1111 1111")).toBeNull());
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .every((mutation) => !JSON.stringify(mutation.state.data).includes("11111111")),
      ).toBe(true);
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => JSON.stringify(mutation.state.data).includes("22222222")),
      ).toBe(true);

      const secondDialog = screen.getAllByRole("dialog", { name: "Код привязки киоска" })[0]!;
      fireEvent.click(within(secondDialog).getByRole("button", { name: "Готово" }));
      await waitFor(() => expect(screen.queryByText("2222 2222")).toBeNull());
    });
  });
});
