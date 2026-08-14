import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider, RequireCapability } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import type * as KiosksApiModule from "../src/pages/kiosks/api.js";
import { KioskPairingPanelRoute } from "../src/pages/kiosks/KioskPairingPanelRoute.js";
import { KioskCreatePanelRoute, KioskEditPanelRoute } from "../src/pages/kiosks/KioskPanelRoute.js";
import { KiosksPage } from "../src/pages/kiosks/index.js";
import { jsonResponse } from "./helpers/http.js";

const { createHookMountSpy, updateHookMountSpy } = vi.hoisted(() => ({
  createHookMountSpy: vi.fn(),
  updateHookMountSpy: vi.fn(),
}));

vi.mock("../src/pages/kiosks/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KiosksApiModule>();
  return {
    ...actual,
    useCreateKiosk: () => {
      createHookMountSpy();
      return actual.useCreateKiosk();
    },
    useUpdateKiosk: () => {
      updateHookMountSpy();
      return actual.useUpdateKiosk();
    },
  };
});

const WRITE_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const WRITE_AND_CREDENTIALS_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const READ_ONLY_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const KIOSK = {
  id: "k1",
  name: "Касса у входа",
  location: "Зал 1",
  dayLimitPerEmployee: 5,
  showPrices: true,
  status: "active",
  lastSeenAt: null,
  enrolled: false,
  productIds: [],
  createdAt: "2026-08-06T00:00:00.000Z",
};

const ARCHIVED_KIOSK = {
  ...KIOSK,
  id: "k9",
  name: "Архивный киоск",
  status: "archived",
  enrolled: true,
};

const PRODUCT = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  productGroup: "Молочные продукты",
  boxCapacity: 12,
  palletCapacity: 48,
  unitPrice: null,
  egaisCode: null,
  externalRef: null,
  status: "active",
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PRODUCT_B = {
  ...PRODUCT,
  id: "p2",
  gtin14: "04600000000018",
  name: "Сыр Российский",
  createdAt: "2026-01-02T00:00:00.000Z",
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
}

function stubFetch(
  handler: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const response = handler(String(url), init);
    if (response) return response;
    if (String(url) === "/api/kiosks") return jsonResponse(200, { items: [] });
    if (String(url).startsWith("/api/products")) return jsonResponse(200, { items: [] });
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderKiosksRouter(
  initialEntries: Array<string | { pathname: string; state: { kiosksBackground: true } }> = [
    "/kiosks",
  ],
  access: AccessDocument = WRITE_ACCESS,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route
        path="/kiosks"
        element={
          <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_READ}>
            <KiosksPage />
          </RequireCapability>
        }
      >
        <Route
          path="new"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
              <KioskCreatePanelRoute />
            </RequireCapability>
          }
        />
        <Route
          path=":kioskId/edit"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.OPERATIONS_WRITE}>
              <KioskEditPanelRoute />
            </RequireCapability>
          }
        />
        <Route
          path=":kioskId/pair"
          element={
            <RequireCapability capability={CABINET_CAPABILITY.CREDENTIALS_MANAGE}>
              <KioskPairingPanelRoute />
            </RequireCapability>
          }
        />
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  createHookMountSpy.mockClear();
  updateHookMountSpy.mockClear();
  await i18n.changeLanguage("ru");
});

it("opens kiosk creation at the nested panel route", async () => {
  stubFetch(() => undefined);
  const { router } = renderKiosksRouter();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить киоск" }));

  expect(router.state.location.pathname).toBe("/kiosks/new");
});

it("creates through the nested panel with the exact normalized payload and returns focus", async () => {
  const created = {
    ...KIOSK,
    id: "k2",
    name: "Киоск склада",
    location: "Цех 2",
    dayLimitPerEmployee: 8,
  };
  let didCreate = false;
  const fetchMock = stubFetch((path, init) => {
    if (path === "/api/kiosks" && init?.method === "POST") {
      didCreate = true;
      return jsonResponse(201, created);
    }
    if (path === "/api/kiosks")
      return jsonResponse(200, { items: didCreate ? [KIOSK, created] : [KIOSK] });
    return undefined;
  });
  const { router } = renderKiosksRouter();
  const user = userEvent.setup();

  const addAction = await screen.findByRole("button", { name: "Добавить киоск" });
  await user.click(addAction);
  expect(router.state.location.pathname).toBe("/kiosks/new");
  expect(screen.getByText(KIOSK.name)).toBeDefined();
  const panel = screen.getByRole("dialog", { name: "Новый киоск" });
  await user.type(within(panel).getByLabelText("Название"), "  Киоск склада  ");
  await user.type(within(panel).getByLabelText("Расположение"), "  Цех 2  ");
  expect(within(panel).queryByLabelText("Лимит позиций на сотрудника в день")).toBeNull();
  await user.click(within(panel).getByRole("button", { name: "Создать" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kiosks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Киоск склада",
          location: "Цех 2",
          showPrices: true,
        }),
      }),
    ),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
  expect(document.activeElement).toBe(addAction);
  expect(await screen.findByText("Киоск склада")).toBeDefined();
});

it("keeps a credential manager in a post-create choice and prevents a second submit", async () => {
  const created = { ...KIOSK, id: "k2", name: "Киоск склада" };
  let didCreate = false;
  const fetchMock = stubFetch((path, init) => {
    if (path === "/api/kiosks" && init?.method === "POST") {
      didCreate = true;
      return jsonResponse(201, created);
    }
    if (path === "/api/kiosks") {
      return jsonResponse(200, { items: didCreate ? [KIOSK, created] : [KIOSK] });
    }
    return undefined;
  });
  const { router } = renderKiosksRouter(["/kiosks/new"], WRITE_AND_CREDENTIALS_ACCESS);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), "Киоск склада");
  await user.click(screen.getByRole("button", { name: "Создать" }));

  const panel = await screen.findByRole("dialog", { name: "Новый киоск" });
  expect(await within(panel).findByText("Киоск создан")).toBeDefined();
  expect(within(panel).getByRole("button", { name: "Настроить привязку" })).toBeDefined();
  expect(within(panel).getByRole("button", { name: "Готово" })).toBeDefined();
  expect(within(panel).queryByRole("button", { name: "Создать" })).toBeNull();
  expect(router.state.location.pathname).toBe("/kiosks/new");
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === "/api/kiosks" && init?.method === "POST",
    ),
  ).toHaveLength(1);

  await user.click(within(panel).getByRole("button", { name: "Готово" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("continues from create to safe pairing without automatically issuing a code", async () => {
  const created = { ...KIOSK, id: "k2", name: "Киоск склада" };
  let didCreate = false;
  const fetchMock = stubFetch((path, init) => {
    if (path === "/api/kiosks" && init?.method === "POST") {
      didCreate = true;
      return jsonResponse(201, created);
    }
    if (path === "/api/kiosks") {
      return jsonResponse(200, { items: didCreate ? [KIOSK, created] : [KIOSK] });
    }
    return undefined;
  });
  const { router } = renderKiosksRouter(
    ["/kiosks", { pathname: "/kiosks/new", state: { kiosksBackground: true } }],
    WRITE_AND_CREDENTIALS_ACCESS,
  );
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), "Киоск склада");
  await user.click(screen.getByRole("button", { name: "Создать" }));
  await user.click(await screen.findByRole("button", { name: "Настроить привязку" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks/k2/pair"));
  expect(router.state.location.state).toEqual({ kiosksBackground: true });
  expect(await screen.findByRole("button", { name: "Сформировать код" })).toBeDefined();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/pairing-code"))).toBe(false);
});

it("continues from create to safe pairing when the kiosk refetch fails", async () => {
  const created = { ...KIOSK, id: "k2", name: "Киоск склада" };
  let kioskListRequests = 0;
  const fetchMock = stubFetch((path, init) => {
    if (path === "/api/kiosks" && init?.method === "POST") {
      return jsonResponse(201, created);
    }
    if (path === "/api/kiosks") {
      kioskListRequests += 1;
      return kioskListRequests === 1
        ? jsonResponse(200, { items: [KIOSK] })
        : jsonResponse(503, { message: "Refetch failed" });
    }
    return undefined;
  });
  const { router } = renderKiosksRouter(["/kiosks/new"], WRITE_AND_CREDENTIALS_ACCESS);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), created.name);
  await user.click(screen.getByRole("button", { name: "Создать" }));
  await screen.findByText("Киоск создан");
  await waitFor(() => expect(kioskListRequests).toBe(2));
  await user.click(screen.getByRole("button", { name: "Настроить привязку" }));

  await waitFor(() => expect(router.state.location.pathname).toBe(`/kiosks/${created.id}/pair`));
  expect(await screen.findByRole("button", { name: "Сформировать код" })).toBeDefined();
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url) === `/api/kiosks/${created.id}/pairing-code` && init?.method === "POST",
    ),
  ).toBe(false);
});

it("falls back to the kiosk list when a directly entered panel closes", async () => {
  stubFetch(() => undefined);
  const { router } = renderKiosksRouter(["/kiosks/new"]);
  const user = userEvent.setup();

  await screen.findByLabelText("Название");
  const panel = await screen.findByRole("dialog", { name: "Новый киоск" });
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("shows the panel load error and retries the kiosk request", async () => {
  let attempts = 0;
  stubFetch((path) => {
    if (path === "/api/kiosks") {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(500, { message: "Unavailable" })
        : jsonResponse(200, { items: [] });
    }
    return undefined;
  });
  renderKiosksRouter(["/kiosks/new"]);

  const panel = await screen.findByRole("dialog", { name: "Новый киоск" });
  expect((await within(panel).findByRole("alert")).textContent).toContain(
    "Не удалось загрузить данные киоска.",
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Повторить" }));

  expect(await screen.findByLabelText("Название")).toBeDefined();
  expect(attempts).toBe(2);
});

it("blocks dirty Back navigation until discarding the kiosk draft", async () => {
  stubFetch(() => undefined);
  const { router } = renderKiosksRouter([
    "/kiosks",
    { pathname: "/kiosks/new", state: { kiosksBackground: true } },
  ]);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), "Киоск склада");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/kiosks/new");
  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("blocks every dismissal and duplicate submission while kiosk creation is pending", async () => {
  let resolveCreate: ((response: Response) => void) | undefined;
  const createResponse = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  const fetchMock = stubFetch((path, init) =>
    path === "/api/kiosks" && init?.method === "POST" ? createResponse : undefined,
  );
  const { router } = renderKiosksRouter([
    "/kiosks",
    { pathname: "/kiosks/new", state: { kiosksBackground: true } },
  ]);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), "Киоск склада");
  const panel = screen.getByRole("dialog", { name: "Новый киоск" });
  const submit = within(panel).getByRole("button", { name: "Создать" });
  await user.click(submit);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/kiosks" && init?.method === "POST",
      ),
    ).toHaveLength(1),
  );

  expect(
    (within(panel).getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (within(panel).getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.click(submit);
  await user.keyboard("{Escape}");
  fireEvent.mouseDown(requiredElement<HTMLElement>(".mk-side-panel__scrim"));
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/kiosks/new");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === "/api/kiosks" && init?.method === "POST",
    ),
  ).toHaveLength(1);

  resolveCreate?.(jsonResponse(201, KIOSK));
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("keeps validation client-side when the kiosk name is empty", async () => {
  const fetchMock = stubFetch(() => undefined);
  renderKiosksRouter(["/kiosks/new"]);
  const user = userEvent.setup();

  await screen.findByLabelText("Название");
  const panel = await screen.findByRole("dialog", { name: "Новый киоск" });
  await user.click(within(panel).getByRole("button", { name: "Создать" }));

  expect(await within(panel).findByText("Укажите название")).toBeDefined();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("keeps the panel, draft values, and persistent API error after a failed kiosk create", async () => {
  stubFetch((path, init) =>
    path === "/api/kiosks" && init?.method === "POST"
      ? jsonResponse(409, { message: "Kiosk already exists" })
      : undefined,
  );
  const { router } = renderKiosksRouter(["/kiosks/new"]);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), "Киоск склада");
  await user.click(screen.getByRole("button", { name: "Создать" }));

  const panel = screen.getByRole("dialog", { name: "Новый киоск" });
  expect(await within(panel).findByText("Kiosk already exists")).toBeDefined();
  expect((within(panel).getByLabelText("Название") as HTMLInputElement).value).toBe("Киоск склада");
  expect(router.state.location.pathname).toBe("/kiosks/new");
});

it("denies a direct read-only URL before the privileged create hook mounts", async () => {
  stubFetch(() => undefined);
  renderKiosksRouter(["/kiosks/new"], READ_ONLY_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(createHookMountSpy).not.toHaveBeenCalled();
});

it("opens kiosk editing at the nested complex-panel route", async () => {
  stubFetch((path) => (path === "/api/kiosks" ? jsonResponse(200, { items: [KIOSK] }) : undefined));
  const { router } = renderKiosksRouter();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Изменить" }));

  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  expect(panel.textContent).toContain(KIOSK.name);
  expect(panel.textContent).toContain("Ожидает привязки");
  expect(panel.classList.contains("mk-side-panel--complex")).toBe(true);
});

it("falls back to the kiosk list when a directly entered edit panel closes", async () => {
  stubFetch((path) => (path === "/api/kiosks" ? jsonResponse(200, { items: [KIOSK] }) : undefined));
  const { router } = renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  await screen.findByLabelText("Название");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("shows an edit-panel load error, retries, and then mounts both resources", async () => {
  let attempts = 0;
  stubFetch((path) => {
    if (path === "/api/kiosks") {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(503, { message: "Unavailable" })
        : jsonResponse(200, { items: [KIOSK] });
    }
    return undefined;
  });
  renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);

  let panel = await screen.findByRole("dialog", { name: "Изменить киоск" });
  expect((await within(panel).findByRole("alert")).textContent).toContain(
    "Не удалось загрузить данные киоска.",
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Повторить" }));

  await screen.findByLabelText("Название");
  panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  expect(await within(panel).findByRole("region", { name: "Профиль" })).toBeDefined();
  expect(within(panel).getByRole("region", { name: "Разрешённые товары" })).toBeDefined();
  expect(attempts).toBe(2);
});

it("shows a translated not-found edit panel without mounting product work", async () => {
  const fetchMock = stubFetch((path) =>
    path === "/api/kiosks" ? jsonResponse(200, { items: [] }) : undefined,
  );
  const { router } = renderKiosksRouter(["/kiosks/missing/edit"]);
  const user = userEvent.setup();

  expect((await screen.findByRole("alert")).textContent).toContain("Киоск не найден.");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/products"))).toBe(false);
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("keeps archived kiosks inspectable without lifecycle actions in the edit panel", async () => {
  stubFetch((path) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [ARCHIVED_KIOSK] });
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [PRODUCT] });
    return undefined;
  });
  renderKiosksRouter([`/kiosks/${ARCHIVED_KIOSK.id}/edit`]);

  await screen.findByLabelText("Название");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  expect(panel.textContent).toContain("Архивный киоск");
  expect(panel.textContent).toContain("В архиве");
  expect(await within(panel).findByLabelText("Название")).toBeDefined();
  expect(within(panel).getByRole("region", { name: "Разрешённые товары" })).toBeDefined();
  expect(within(panel).queryByRole("button", { name: "Код привязки" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "В архив" })).toBeNull();
});

it("submits only the exact normalized profile PATCH and closes after success", async () => {
  const updated = {
    ...KIOSK,
    name: "Новый склад",
    location: null,
    dayLimitPerEmployee: 8,
    showPrices: false,
  };
  let didPatch = false;
  const fetchMock = stubFetch((path, init) => {
    if (path === `/api/kiosks/${KIOSK.id}` && init?.method === "PATCH") {
      didPatch = true;
      return jsonResponse(200, updated);
    }
    if (path === "/api/kiosks") {
      return jsonResponse(200, { items: [didPatch ? updated : KIOSK] });
    }
    return undefined;
  });
  const { router } = renderKiosksRouter([
    "/kiosks",
    { pathname: `/kiosks/${KIOSK.id}/edit`, state: { kiosksBackground: true } },
  ]);
  const user = userEvent.setup();

  await screen.findByLabelText("Название");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  await user.clear(within(panel).getByLabelText("Название"));
  await user.type(within(panel).getByLabelText("Название"), "  Новый склад  ");
  await user.clear(within(panel).getByLabelText("Расположение"));
  expect(within(panel).queryByLabelText("Лимит позиций на сотрудника в день")).toBeNull();
  await user.click(within(panel).getByLabelText("Показывать цены"));
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/kiosks/${KIOSK.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "Новый склад",
          location: null,
          showPrices: false,
        }),
      }),
    ),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("keeps product work independent when profile update fails", async () => {
  stubFetch((path, init) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [KIOSK] });
    if (path === `/api/kiosks/${KIOSK.id}` && init?.method === "PATCH") {
      return jsonResponse(409, { message: "Name already exists" });
    }
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [PRODUCT] });
    return undefined;
  });
  const { router } = renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  await screen.findByLabelText("Название");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  await user.clear(within(panel).getByLabelText("Название"));
  await user.type(within(panel).getByLabelText("Название"), "Новый склад");
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  expect((await within(panel).findByRole("alert")).textContent).toContain("Name already exists");
  expect((within(panel).getByLabelText("Название") as HTMLInputElement).value).toBe("Новый склад");
  expect(within(panel).getByRole("region", { name: "Разрешённые товары" })).toBeDefined();
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);
});

it("retains a dirty kiosk editor when a background refetch omits the kiosk", async () => {
  let kiosks = [KIOSK];
  stubFetch((path) => (path === "/api/kiosks" ? jsonResponse(200, { items: kiosks }) : undefined));
  const { queryClient, router } = renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Название");
  await user.type(name, " draft");
  kiosks = [];
  await queryClient.invalidateQueries({ queryKey: ["kiosks"] });

  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  expect(
    await within(panel).findByText(
      "Киоск не найден в обновлённом списке. Несохранённые изменения сохранены в редакторе.",
    ),
  ).toBeDefined();
  expect((within(panel).getByLabelText("Название") as HTMLInputElement).value).toBe(
    `${KIOSK.name} draft`,
  );
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);

  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Продолжить редактирование" }));

  const retainedName = within(panel).getByLabelText("Название");
  await user.clear(retainedName);
  await user.type(retainedName, KIOSK.name);
  expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toContain(
    "Киоск не найден.",
  );
});

it("applies deferred server profile values after a dirty form returns to clean", async () => {
  let kiosk = KIOSK;
  stubFetch((path) => (path === "/api/kiosks" ? jsonResponse(200, { items: [kiosk] }) : undefined));
  const { queryClient } = renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Название");
  await user.clear(name);
  await user.type(name, "Локальная правка");
  kiosk = { ...KIOSK, name: "Серверная правка" };
  await queryClient.invalidateQueries({ queryKey: ["kiosks"] });

  expect((name as HTMLInputElement).value).toBe("Локальная правка");
  await user.clear(name);
  await user.type(name, KIOSK.name);

  await waitFor(() => expect((name as HTMLInputElement).value).toBe("Серверная правка"));
});

it("keeps both sections mounted and activates a section by scrolling and focusing its heading", async () => {
  stubFetch((path) => {
    if (path === "/api/kiosks")
      return jsonResponse(200, { items: [{ ...KIOSK, productIds: [PRODUCT.id] }] });
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [PRODUCT] });
    return undefined;
  });
  renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  await screen.findByRole("region", { name: "Профиль" });
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  const profile = within(panel).getByRole("region", { name: "Профиль" });
  const products = within(panel).getByRole("region", { name: "Разрешённые товары" });
  expect(profile).toBeDefined();
  const navigation = within(panel).getByRole("navigation", { name: "Разделы киоска" });
  const profileAction = within(navigation).getByRole("button", { name: /Профиль/ });
  const productsAction = await within(navigation).findByRole("button", {
    name: /Разрешённые товары.*Выбрано: 1/,
  });
  expect(profileAction.getAttribute("aria-current")).toBe("location");
  const heading = within(products).getByRole("heading", { name: "Разрешённые товары" });
  const scrollIntoView = vi.fn();
  Object.defineProperty(products, "scrollIntoView", { configurable: true, value: scrollIntoView });

  await user.click(productsAction);

  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(productsAction.getAttribute("aria-current")).toBe("location");
  expect(document.activeElement).toBe(heading);
  expect(within(panel).getByRole("region", { name: "Профиль" })).toBe(profile);
});

it("keeps product rail metadata synchronized with loading, errors, and the current draft count", async () => {
  let resolveProducts: ((response: Response) => void) | undefined;
  const firstProductsResponse = new Promise<Response>((resolve) => {
    resolveProducts = resolve;
  });
  let productAttempts = 0;
  stubFetch((path) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [KIOSK] });
    if (path === "/api/products?status=active") {
      productAttempts += 1;
      return productAttempts === 1
        ? firstProductsResponse
        : jsonResponse(200, { items: [PRODUCT, PRODUCT_B] });
    }
    return undefined;
  });
  renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  await screen.findByRole("region", { name: "Профиль" });
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  let navigation = within(panel).getByRole("navigation", { name: "Разделы киоска" });
  expect(
    within(navigation).getByRole("button", { name: /Разрешённые товары.*Загрузка/ }),
  ).toBeDefined();

  resolveProducts?.(jsonResponse(503, { message: "Catalog unavailable" }));
  expect(await within(panel).findByText("Не удалось загрузить товары.")).toBeDefined();
  navigation = within(panel).getByRole("navigation", { name: "Разделы киоска" });
  expect(
    within(navigation).getByRole("button", { name: /Разрешённые товары.*Ошибка/ }),
  ).toBeDefined();

  await user.click(within(panel).getByRole("button", { name: "Повторить" }));
  await within(panel).findByRole("checkbox", { name: PRODUCT_B.name });
  navigation = within(panel).getByRole("navigation", { name: "Разделы киоска" });
  expect(
    within(navigation).getByRole("button", { name: /Разрешённые товары.*Выбрано: 0/ }),
  ).toBeDefined();

  await user.click(within(panel).getByRole("checkbox", { name: PRODUCT_B.name }));

  expect(
    within(navigation).getByRole("button", { name: /Разрешённые товары.*Выбрано: 1/ }),
  ).toBeDefined();
});

it("marks Profile navigation for client validation errors and clears it after correction", async () => {
  stubFetch((path) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [KIOSK] });
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [] });
    return undefined;
  });
  renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Название");
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  const navigation = within(panel).getByRole("navigation", { name: "Разделы киоска" });
  await user.clear(name);
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));

  expect(await within(navigation).findByRole("button", { name: /Профиль.*Ошибка/ })).toBeDefined();

  await user.type(name, "Исправленный киоск");

  await waitFor(() =>
    expect(within(navigation).getByRole("button", { name: /^Профиль$/ })).toBeDefined(),
  );
});

it("blocks dirty Back navigation until the kiosk edit is discarded", async () => {
  stubFetch((path) => (path === "/api/kiosks" ? jsonResponse(200, { items: [KIOSK] }) : undefined));
  const { router } = renderKiosksRouter([
    "/kiosks",
    { pathname: `/kiosks/${KIOSK.id}/edit`, state: { kiosksBackground: true } },
  ]);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText("Название"), " draft");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);
  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  await user.click(within(confirmation).getByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
});

it("blocks every dismissal while a product save is busy and keeps the panel open after success", async () => {
  let resolveSave: ((response: Response) => void) | undefined;
  const saveResponse = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  stubFetch((path, init) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [KIOSK] });
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [PRODUCT] });
    if (path === `/api/kiosks/${KIOSK.id}/products` && init?.method === "PUT") return saveResponse;
    return undefined;
  });
  const { router } = renderKiosksRouter([
    "/kiosks",
    { pathname: `/kiosks/${KIOSK.id}/edit`, state: { kiosksBackground: true } },
  ]);
  const user = userEvent.setup();

  await screen.findByRole("checkbox", { name: PRODUCT.name });
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  await user.click(within(panel).getByRole("checkbox", { name: PRODUCT.name }));
  await user.click(within(panel).getByRole("button", { name: "Сохранить список" }));
  await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("true"));

  expect(
    (within(panel).getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (within(panel).getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await router.navigate(-1);
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);

  resolveSave?.(jsonResponse(200, { ...KIOSK, productIds: [PRODUCT.id] }));
  await waitFor(() => expect(panel.hasAttribute("aria-busy")).toBe(false));
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);
});

it("does not start or finish a profile save while a product save is pending", async () => {
  let resolveProductSave: ((response: Response) => void) | undefined;
  const productSaveResponse = new Promise<Response>((resolve) => {
    resolveProductSave = resolve;
  });
  const fetchMock = stubFetch((path, init) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [KIOSK] });
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [PRODUCT] });
    if (path === `/api/kiosks/${KIOSK.id}/products` && init?.method === "PUT") {
      return productSaveResponse;
    }
    if (path === `/api/kiosks/${KIOSK.id}` && init?.method === "PATCH") {
      return jsonResponse(200, { ...KIOSK, name: "Новый киоск" });
    }
    return undefined;
  });
  const { router } = renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Название");
  await screen.findByRole("checkbox", { name: PRODUCT.name });
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  await user.clear(name);
  await user.type(name, "Новый киоск");
  await user.click(within(panel).getByRole("checkbox", { name: PRODUCT.name }));
  await user.click(within(panel).getByRole("button", { name: "Сохранить список" }));
  await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("true"));
  expect(
    (within(panel).getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  await act(async () => {
    fireEvent.submit(requiredElement<HTMLFormElement>("#kiosk-profile-form"));
    await Promise.resolve();
  });

  expect(
    fetchMock.mock.calls.filter(
      ([path, init]) => path === `/api/kiosks/${KIOSK.id}` && init?.method === "PATCH",
    ),
  ).toHaveLength(0);
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);

  resolveProductSave?.(jsonResponse(200, { ...KIOSK, productIds: [PRODUCT.id] }));
  await waitFor(() => expect(panel.hasAttribute("aria-busy")).toBe(false));
});

it("does not start a product save while a profile save is pending or discard its draft", async () => {
  let resolveProfileSave: ((response: Response) => void) | undefined;
  let currentKiosk: KiosksApiModule.KioskDto = { ...KIOSK, status: "active" };
  const profileSaveResponse = new Promise<Response>((resolve) => {
    resolveProfileSave = resolve;
  });
  const fetchMock = stubFetch((path, init) => {
    if (path === "/api/kiosks") return jsonResponse(200, { items: [currentKiosk] });
    if (path === "/api/products?status=active") return jsonResponse(200, { items: [PRODUCT] });
    if (path === `/api/kiosks/${KIOSK.id}` && init?.method === "PATCH") {
      return profileSaveResponse;
    }
    if (path === `/api/kiosks/${KIOSK.id}/products` && init?.method === "PUT") {
      currentKiosk = { ...currentKiosk, productIds: [PRODUCT.id] };
      return jsonResponse(200, currentKiosk);
    }
    return undefined;
  });
  const { router } = renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`]);
  const user = userEvent.setup();

  const name = await screen.findByLabelText("Название");
  await screen.findByRole("checkbox", { name: PRODUCT.name });
  const panel = screen.getByRole("dialog", { name: "Изменить киоск" });
  const checkbox = within(panel).getByRole("checkbox", { name: PRODUCT.name });
  await user.click(checkbox);
  const productSave = within(panel).getByRole("button", { name: "Сохранить список" });
  await user.type(name, " draft");
  await user.click(within(panel).getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("true"));

  expect((checkbox as HTMLButtonElement).disabled).toBe(true);
  expect((productSave as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(productSave);
  expect(
    fetchMock.mock.calls.filter(
      ([path, init]) => path === `/api/kiosks/${KIOSK.id}/products` && init?.method === "PUT",
    ),
  ).toHaveLength(0);
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);

  currentKiosk = { ...currentKiosk, name: `${KIOSK.name} draft` };
  resolveProfileSave?.(jsonResponse(200, currentKiosk));
  await waitFor(() => expect(panel.hasAttribute("aria-busy")).toBe(false));
  expect(router.state.location.pathname).toBe(`/kiosks/${KIOSK.id}/edit`);
  expect(checkbox.getAttribute("aria-checked")).toBe("true");

  await user.click(productSave);
  await waitFor(() => expect(panel.hasAttribute("aria-busy")).toBe(false));
  await user.click(within(panel).getByRole("button", { name: "Закрыть" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
  expect(screen.queryByRole("alertdialog", { name: "Отменить изменения?" })).toBeNull();
});

it("denies a direct read-only edit URL before the privileged update hook mounts", async () => {
  stubFetch(() => undefined);
  renderKiosksRouter([`/kiosks/${KIOSK.id}/edit`], READ_ONLY_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(updateHookMountSpy).not.toHaveBeenCalled();
});
