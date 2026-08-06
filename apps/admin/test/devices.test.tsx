import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { DevicesPage } from "../src/pages/devices/index.js";

function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }
function renderPage() { vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { const url = String(input); if (url.startsWith("/api/devices")) return response({ items: [{ id: "kiosk-1", type: "kiosk", name: "Entrance kiosk", place: { id: null, name: "Lobby" }, status: "online", lastSeenAt: null, paired: true }], page: 1, pageSize: 8, total: 1 }); if (url === "/api/lines") return response({ items: [] }); throw new Error(`Unexpected request: ${url}`); })); return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeProvider defaultTheme="light"><MemoryRouter><AccessProvider value={{ roles: ["admin"], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE] }}><DevicesPage /></AccessProvider></MemoryRouter></ThemeProvider></QueryClientProvider>); }
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage("ru"); });
it("keeps kiosk settings reachable from the unified device row", async () => { renderPage(); await screen.findByText("Entrance kiosk"); expect(screen.getByRole("link", { name: "Настройки киоска" }).getAttribute("href")).toBe("/kiosks/kiosk-1"); });

it("sends filter and pager state to the bounded devices endpoint", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url.startsWith("/api/devices")) return response({ items: [{ id: "station-1", type: "station", name: "Packing", place: { id: "line-1", name: "Line 1" }, status: "online", lastSeenAt: null, paired: true }], page: url.includes("page=2") ? 2 : 1, pageSize: 8, total: 16 });
    if (url === "/api/lines") return response({ items: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeProvider defaultTheme="light"><MemoryRouter><AccessProvider value={{ roles: ["admin"], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE] }}><DevicesPage /></AccessProvider></MemoryRouter></ThemeProvider></QueryClientProvider>);
  await screen.findByText("Packing");
  fireEvent.change(screen.getByLabelText("Тип"), { target: { value: "kiosk" } });
  await waitFor(() => expect(requests).toContain("/api/devices?page=1&pageSize=8&type=kiosk"));
  await screen.findByText("Packing");
  fireEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
  await waitFor(() => expect(requests).toContain("/api/devices?page=2&pageSize=8&type=kiosk"));
});

it("keeps the drawer open in its code stage after creating a kiosk", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/devices")) return response({ items: [], page: 1, pageSize: 8, total: 0 });
    if (url === "/api/lines") return response({ items: [] });
    if (url === "/api/kiosks" && init?.method === "POST") return response({ id: "kiosk-2" });
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ThemeProvider defaultTheme="light"><MemoryRouter><AccessProvider value={{ roles: ["admin"], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE] }}><DevicesPage /></AccessProvider></MemoryRouter></ThemeProvider></QueryClientProvider>);
  await screen.findByText("Устройства не добавлены");
  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const dialog = await screen.findByRole("dialog", { name: "Новое устройство" });
  fireEvent.change(within(dialog).getByLabelText("Тип"), { target: { value: "kiosk" } });
  expect(within(dialog).getByLabelText("Расположение")).toBeDefined();
  fireEvent.change(within(dialog).getByLabelText("Название"), { target: { value: "Lobby kiosk" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Создать" }));
  await screen.findByRole("dialog", { name: "Привязка устройства" });
  expect(dialog.isConnected).toBe(true);
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
});
