import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as KiosksApiModule from "../src/pages/kiosks/api.js";
import { KiosksPage } from "../src/pages/kiosks/index.js";
import { ReasonsPage } from "../src/pages/kiosks/ReasonsPage.js";

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  writeHookMountSpy.mockClear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <MemoryRouter>
          <KiosksPage />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

function renderReasonsPage(access: AccessDocument = ADMIN_ACCESS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <MemoryRouter initialEntries={["/kiosks/reasons"]}>
          <ReasonsPage />
        </MemoryRouter>
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
  it("does not load products until an authorized edit surface opens", async () => {
    const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK] });
    renderPage();

    expect(await screen.findByText(ONLINE_KIOSK.name)).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/products"))).toBe(
      false,
    );
  });

  it("renders the table-shaped loading state until the kiosk request resolves", async () => {
    const kioskResponse = deferred<Response>();
    stubFetch({
      onPost: (path) => (path === "/api/kiosks" ? kioskResponse.promise : undefined),
    });
    renderPage();

    expect(screen.getByRole("status", { name: "Загрузка…" }).querySelector("table")).not.toBeNull();
    await act(async () => {
      kioskResponse.resolve(jsonResponse(200, { items: [ONLINE_KIOSK] }));
    });
    expect(await screen.findByText(ONLINE_KIOSK.name)).toBeDefined();
  });

  it("retries a failed kiosk list request", async () => {
    let kioskRequests = 0;
    const fetchMock = stubFetch({
      kiosks: [ONLINE_KIOSK],
      onPost: (path) => {
        if (path !== "/api/kiosks") return undefined;
        kioskRequests += 1;
        return kioskRequests === 1
          ? jsonResponse(500, { message: "Temporary error" })
          : jsonResponse(200, { items: [ONLINE_KIOSK] });
      },
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("alert")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText(ONLINE_KIOSK.name)).toBeDefined();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/kiosks")).toHaveLength(2);
  });

  it("distinguishes awaiting pairing from an enrolled offline kiosk", async () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    vi.setSystemTime(now);
    stubFetch({
      kiosks: [
        { ...OFFLINE_KIOSK, id: "awaiting", enrolled: false, lastSeenAt: null },
        {
          ...OFFLINE_KIOSK,
          id: "offline",
          enrolled: true,
          lastSeenAt: new Date(now - 6 * 60_000 - 1).toISOString(),
        },
      ],
      products: [],
      reasons: [],
    });
    renderPage();

    expect(await screen.findByText("Ожидает привязки")).toBeDefined();
    expect(screen.getByText("Не в сети")).toBeDefined();
  });

  it("gives archived kiosks precedence and treats the online threshold as online", async () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    vi.setSystemTime(now);
    stubFetch({
      kiosks: [
        { ...ARCHIVED_KIOSK, lastSeenAt: null, enrolled: false },
        {
          ...ONLINE_KIOSK,
          id: "threshold",
          lastSeenAt: new Date(now - 6 * 60_000).toISOString(),
        },
      ],
      products: [],
      reasons: [],
    });
    renderPage();

    expect(await screen.findByText("В архиве")).toBeDefined();
    expect(screen.getByText("В сети")).toBeDefined();
  });

  it("shows Never for a kiosk with no recorded activity", async () => {
    stubFetch({ kiosks: [OFFLINE_KIOSK], products: [], reasons: [] });
    renderPage();

    expect(await screen.findByText("Никогда")).toBeDefined();
  });

  it("includes the absolute last activity in the time element's accessible label", async () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    vi.setSystemTime(now);
    const lastSeenAt = new Date(now - 60_000).toISOString();
    stubFetch({ kiosks: [{ ...ONLINE_KIOSK, lastSeenAt }], products: [], reasons: [] });
    renderPage();

    await screen.findByText(ONLINE_KIOSK.name);
    const time = document.querySelector<HTMLTimeElement>(`time[datetime="${lastSeenAt}"]`);
    expect(time).not.toBeNull();
    const relative = time?.textContent ?? "";
    const absolute = time?.getAttribute("title") ?? "";
    expect(relative).not.toBe("");
    expect(absolute).not.toBe("");
    expect(time?.getAttribute("aria-label")).toContain(relative);
    expect(time?.getAttribute("aria-label")).toContain(absolute);
  });

  it("filters the fetched rows without adding query parameters", async () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    vi.setSystemTime(now);
    const fetchMock = stubFetch({
      kiosks: [
        { ...ONLINE_KIOSK, lastSeenAt: new Date(now - 1_000).toISOString() },
        { ...OFFLINE_KIOSK, enrolled: true },
      ],
      products: [],
      reasons: [],
    });
    const user = userEvent.setup();
    renderPage();

    await chooseOption(user, "Состояние", "В сети");
    expect(screen.getByText(ONLINE_KIOSK.name)).toBeDefined();
    expect(screen.queryByText(OFFLINE_KIOSK.name)).toBeNull();
    const kioskCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/kiosks"),
    );
    expect(kioskCalls).toHaveLength(1);
    expect(kioskCalls[0]?.[0]).toBe("/api/kiosks");
  });

  it("resets the state filter and renders the filtered empty state", async () => {
    const user = userEvent.setup();
    stubFetch({ kiosks: [OFFLINE_KIOSK], products: [], reasons: [] });
    renderPage();

    await chooseOption(user, "Состояние", "В сети");
    expect(await screen.findByText("Нет киосков в выбранном состоянии")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(await screen.findByText(OFFLINE_KIOSK.name)).toBeDefined();
  });

  it("updates all rows from online to offline on the shared clock tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    vi.setSystemTime(now);
    stubFetch({
      kiosks: [
        {
          ...ONLINE_KIOSK,
          lastSeenAt: new Date(now - 6 * 60_000 + 1).toISOString(),
        },
      ],
      products: [],
      reasons: [],
    });
    renderPage();

    expect(await screen.findByText("В сети")).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText("Не в сети")).toBeDefined();
  });

  it("polls kiosk activity so a new five-minute heartbeat keeps the row online", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    vi.setSystemTime(now);
    let kioskRequests = 0;
    const fetchMock = stubFetch({
      kiosks: [],
      products: [],
      reasons: [],
      onPost: (path) => {
        if (path !== "/api/kiosks") return undefined;
        kioskRequests += 1;
        return jsonResponse(200, {
          items: [
            {
              ...ONLINE_KIOSK,
              lastSeenAt:
                kioskRequests === 1
                  ? new Date(now - 5.5 * 60_000).toISOString()
                  : new Date(Date.now()).toISOString(),
            },
          ],
        });
      },
    });
    renderPage();

    expect(await screen.findByText("В сети")).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/kiosks").length).toBeGreaterThan(1);
    expect(screen.getByText("В сети")).toBeDefined();
  });

  it("keeps kiosk archive confirmation open with the server error", async () => {
    stubFetch({
      kiosks: [ONLINE_KIOSK],
      products: [],
      reasons: [],
      onPost: (_path, init) =>
        init?.method === "DELETE"
          ? jsonResponse(409, { message: "Kiosk has pending pickup work" })
          : undefined,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "В архив" }));
    const dialog = screen.getByRole("alertdialog", { name: "Отправить киоск в архив?" });
    await user.click(within(dialog).getByRole("button", { name: "В архив" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Kiosk has pending pickup work",
    );
  });

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
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/pickup-reasons")),
    ).toBe(false);
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

  it("does not mount reason mutations for read-only reasons access", async () => {
    stubFetch({ reasons: [REASON_A] });
    renderReasonsPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(REASON_A.name)).toBeDefined();
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

  it("renders the kiosks list with state derived from enrollment and last activity", async () => {
    stubFetch({ kiosks: [ONLINE_KIOSK, OFFLINE_KIOSK], products: [PRODUCT_A, PRODUCT_B] });

    renderPage();

    expect(await screen.findByText("Касса у входа")).toBeDefined();
    expect(screen.getByText("Склад")).toBeDefined();
    expect(screen.getByText("Зал 1")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined(); // OFFLINE_KIOSK.location is null
    expect(screen.getByText("В сети")).toBeDefined();
    expect(screen.getByText("Ожидает привязки")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Да")).toBeDefined();
    expect(screen.getByText("Нет")).toBeDefined();
  });

  it('clicking "Код привязки" does not mint or reveal a code from the list', async () => {
    const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK] });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Код привязки" }));

    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/pairing-code"))).toBe(
      false,
    );
    expect(screen.queryByText("1234 5678")).toBeNull();
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
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks/k1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
