import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { DevicesPage } from "../src/pages/devices/index.js";

vi.mock("../src/layout/useActiveOrg.js", () => ({
  useActiveOrg: () => ({ orgId: "org-1", orgName: "Factory" }),
}));

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function activeExpiry(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function renderPage() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/devices"))
        return response({
          items: [
            {
              id: "kiosk-1",
              type: "kiosk",
              name: "Entrance kiosk",
              place: { id: null, name: "Lobby" },
              status: "online",
              lastSeenAt: null,
              paired: true,
            },
          ],
          page: 1,
          pageSize: 8,
          total: 1,
        });
      if (url === "/api/lines") return response({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider
            value={{
              roles: ["admin"],
              capabilities: [
                CABINET_CAPABILITY.OPERATIONS_READ,
                CABINET_CAPABILITY.OPERATIONS_WRITE,
                CABINET_CAPABILITY.CREDENTIALS_MANAGE,
              ],
            }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});
it("keeps kiosk settings reachable as a button-styled action in the unified device row", async () => {
  renderPage();
  await screen.findByText("Entrance kiosk");
  const settings = screen.getByRole("link", { name: "Настройки киоска" });
  expect(settings.className).toContain("mk-device-actions__kiosk-settings");
  expect(settings.getAttribute("href")).toBe("/kiosks/kiosk-1/edit");
});

it("does not leave auth cleanup tied to the jsdom window", async () => {
  vi.useFakeTimers();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

  try {
    renderPage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({})),
    );
    await vi.advanceTimersByTimeAsync(0);
    cleanup();

    Reflect.deleteProperty(globalThis, "window");
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("sends filter and pager state to the bounded devices endpoint", async () => {
  const user = userEvent.setup();
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("/api/devices"))
        return response({
          items: [
            {
              id: "station-1",
              type: "station",
              name: "Packing",
              place: { id: "line-1", name: "Line 1" },
              status: "online",
              lastSeenAt: null,
              paired: true,
            },
          ],
          page: url.includes("page=2") ? 2 : 1,
          pageSize: 8,
          total: 16,
        });
      if (url === "/api/lines") return response({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider
            value={{
              roles: ["admin"],
              capabilities: [
                CABINET_CAPABILITY.OPERATIONS_READ,
                CABINET_CAPABILITY.OPERATIONS_WRITE,
                CABINET_CAPABILITY.CREDENTIALS_MANAGE,
              ],
            }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Packing");
  expect(document.querySelectorAll("select")).toHaveLength(0);
  expect(screen.getByRole("combobox", { name: "Тип" }).tagName).toBe("BUTTON");
  await user.click(screen.getByRole("combobox", { name: "Тип" }));
  await user.click(screen.getByRole("option", { name: "Киоск" }));
  await waitFor(() => expect(requests).toContain("/api/devices?page=1&pageSize=8&type=kiosk"));
  await screen.findByText("Packing");
  fireEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
  await waitFor(() => expect(requests).toContain("/api/devices?page=2&pageSize=8&type=kiosk"));
});

it("hydrates and clears URL filters independently while resetting the page", async () => {
  const user = userEvent.setup();
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("/api/devices"))
        return response({ items: [], page: 1, pageSize: 8, total: 0 });
      if (url === "/api/lines") return response({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={["/devices?type=kiosk&status=offline&page=2"]}>
          <AccessProvider
            value={{ roles: ["admin"], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(requests).toContain("/api/devices?page=2&pageSize=8&type=kiosk&status=offline"),
  );
  expect(screen.getByRole("combobox", { name: "Тип" }).textContent).toContain("Киоск");
  expect(screen.getByRole("combobox", { name: "Статус" }).textContent).toContain("Не в сети");
  await user.click(screen.getByRole("combobox", { name: "Тип" }));
  await user.click(screen.getByRole("option", { name: "Все типы" }));
  await waitFor(() => expect(requests).toContain("/api/devices?page=1&pageSize=8&status=offline"));
  await user.click(screen.getByRole("combobox", { name: "Статус" }));
  await user.click(screen.getByRole("option", { name: "Все статусы" }));
  await waitFor(() => expect(requests).toContain("/api/devices?page=1&pageSize=8"));
});

it("hides Add device when the grant cannot create either type", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ items: [], page: 1, pageSize: 8, total: 0 })),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider value={{ roles: [], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] }}>
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Устройства не добавлены");
  expect(screen.queryByRole("button", { name: "Добавить устройство" })).toBeNull();
});

it("keeps a station unassigned and directs operators to Production -> Lines when no lines exist", async () => {
  renderPage();
  await screen.findByText("Entrance kiosk");

  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const drawer = await screen.findByRole("dialog", { name: "Новое устройство" });
  expect(within(drawer).getByRole("combobox", { name: "Линия" }).textContent).toContain(
    "Без линии",
  );
  expect(
    await within(drawer).findByText("Линии создаются в разделе «Производство -> Линии»."),
  ).toBeDefined();
  expect(within(drawer).getByRole("link", { name: "Управлять линиями" }).getAttribute("href")).toBe(
    "/lines",
  );
});

it("lets a credentials-only operator create and pair a station without operations.write", async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init?.method ? { method: init.method } : {}) });
      if (url.startsWith("/api/devices"))
        return response({ items: [], page: 1, pageSize: 8, total: 0 });
      if (url === "/api/lines") return response({ items: [] });
      if (url === "/api/station-devices" && init?.method === "POST")
        return response({ id: "station-credentials", name: "Packing station" });
      if (
        url === "/api/station-devices/station-credentials/pairing-code" &&
        init?.method === "POST"
      )
        return response({ code: "12345678", expiresAt: activeExpiry() });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider
            value={{
              roles: [],
              capabilities: [
                CABINET_CAPABILITY.OPERATIONS_READ,
                CABINET_CAPABILITY.CREDENTIALS_MANAGE,
              ],
            }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );

  await screen.findByText("Устройства не добавлены");
  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const drawer = await screen.findByRole("dialog", { name: "Новое устройство" });
  expect(within(drawer).getByRole("combobox", { name: "Тип" }).textContent).toContain("Станция");
  expect(within(drawer).queryByRole("option", { name: "Киоск" })).toBeNull();
  fireEvent.change(within(drawer).getByLabelText("Название"), {
    target: { value: "Packing station" },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "Создать" }));
  expect(await screen.findAllByText("1234 5678")).toHaveLength(2);
  expect(requests).toContainEqual({ url: "/api/station-devices", method: "POST" });
  expect(requests).toContainEqual({
    url: "/api/station-devices/station-credentials/pairing-code",
    method: "POST",
  });
  expect(requests.some((request) => request.url === "/api/kiosks")).toBe(false);
});

it("lets an operations-only user create a kiosk without issuing a pairing code", async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init?.method ? { method: init.method } : {}) });
      if (url.startsWith("/api/devices"))
        return response({ items: [], page: 1, pageSize: 8, total: 0 });
      if (url === "/api/lines") return response({ items: [] });
      if (url === "/api/kiosks") return response({ id: "kiosk-ops", name: "Ops kiosk" });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider
            value={{
              roles: ["manager"],
              capabilities: [
                CABINET_CAPABILITY.OPERATIONS_READ,
                CABINET_CAPABILITY.OPERATIONS_WRITE,
              ],
            }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Устройства не добавлены");
  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const drawer = await screen.findByRole("dialog", { name: "Новое устройство" });
  expect(within(drawer).getByRole("combobox", { name: "Тип" }).textContent).toContain("Киоск");
  expect(within(drawer).queryByRole("option", { name: "Станция" })).toBeNull();
  fireEvent.change(within(drawer).getByLabelText("Название"), { target: { value: "Ops kiosk" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Создать" }));
  await screen.findByText(/ожидает привязки/);
  expect(requests.some((request) => request.url.includes("pairing-code"))).toBe(false);
});

it("keeps the drawer open in its code stage after creating a kiosk", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/devices"))
        return response({ items: [], page: 1, pageSize: 8, total: 0 });
      if (url === "/api/lines") return response({ items: [] });
      if (url === "/api/kiosks" && init?.method === "POST")
        return response({ id: "kiosk-2", name: "Lobby kiosk" });
      if (url === "/api/kiosks/kiosk-2/pairing-code" && init?.method === "POST")
        return response({ code: "12345678", expiresAt: activeExpiry() });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <AccessProvider
            value={{
              roles: ["admin"],
              capabilities: [
                CABINET_CAPABILITY.OPERATIONS_READ,
                CABINET_CAPABILITY.OPERATIONS_WRITE,
                CABINET_CAPABILITY.CREDENTIALS_MANAGE,
              ],
            }}
          >
            <DevicesPage />
          </AccessProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("Устройства не добавлены");
  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const dialog = await screen.findByRole("dialog", { name: "Новое устройство" });
  await user.click(within(dialog).getByRole("combobox", { name: "Тип" }));
  await user.click(screen.getByRole("option", { name: "Киоск" }));
  expect(within(dialog).getByLabelText("Расположение")).toBeDefined();
  fireEvent.change(within(dialog).getByLabelText("Название"), { target: { value: "Lobby kiosk" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Создать" }));
  await screen.findByRole("dialog", { name: "Привязка устройства" });
  await screen.findByText("12345678");
  expect(dialog.isConnected).toBe(true);
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
});
