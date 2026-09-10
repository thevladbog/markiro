import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

const HANDHELD_ROW = {
  id: "hh-1",
  type: "handheld",
  name: "ТСД 1",
  place: { id: "line-2", name: "Линия 2" },
  status: "awaiting_pairing",
  lastSeenAt: null,
  paired: false,
};

function renderPage(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
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
}

it("renders a handheld row with its type and offers the type filter", async () => {
  await i18n.changeLanguage("ru");
  const urls: string[] = [];
  renderPage(
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("/api/devices"))
        return response({ items: [HANDHELD_ROW], page: 1, pageSize: 8, total: 1 });
      if (url === "/api/lines") return response({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  await screen.findByText("ТСД 1");
  expect(screen.getAllByText("ТСД").length).toBeGreaterThan(0);

  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Тип" }));
  await user.click(await screen.findByRole("option", { name: "ТСД" }));
  expect(urls.some((url) => url.includes("type=handheld"))).toBe(true);
});

it("creates a handheld bound to a line and shows the pairing code", async () => {
  await i18n.changeLanguage("ru");
  const posted: unknown[] = [];
  renderPage(
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/devices"))
        return response({ items: [], page: 1, pageSize: 8, total: 0 });
      if (url === "/api/lines") return response({ items: [{ id: "line-2", name: "Линия 2" }] });
      if (url === "/api/station-devices" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return response({ id: "hh-new", name: "ТСД 1" });
      }
      if (url === "/api/station-devices/hh-new/pairing-code" && init?.method === "POST")
        return response({
          code: "12345678",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  await screen.findByText("Устройства не добавлены");
  fireEvent.click(screen.getByRole("button", { name: "Добавить устройство" }));
  const drawer = await screen.findByRole("dialog", { name: "Новое устройство" });

  const user = userEvent.setup();
  await user.click(within(drawer).getByRole("combobox", { name: "Тип" }));
  await user.click(await screen.findByRole("option", { name: "ТСД" }));
  expect(within(drawer).queryByRole("link", { name: "Скачать Station для Windows" })).toBeNull();
  await user.click(within(drawer).getByRole("combobox", { name: "Линия" }));
  await user.click(await screen.findByRole("option", { name: "Линия 2" }));
  fireEvent.change(within(drawer).getByLabelText("Название"), { target: { value: "ТСД 1" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Создать" }));

  expect(await screen.findAllByText("1234 5678")).toHaveLength(2);
  expect(posted).toEqual([{ name: "ТСД 1", lineId: "line-2", kind: "handheld" }]);
  expect(within(drawer).getAllByText("ТСД").length).toBeGreaterThan(0);
});
