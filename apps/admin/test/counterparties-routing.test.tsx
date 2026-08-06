import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { CounterpartiesPage } from "../src/pages/counterparties/index.js";
import { CounterpartyPanelRoute } from "../src/pages/counterparties/CounterpartyPanelRoute.js";

const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const ACME = {
  id: "1",
  name: "Acme Ltd",
  gln: "6291041500213",
  inn: "7701234567",
  gs1Prefixes: ["4600000"],
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel(initialEntries: string[]) {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/counterparties" element={<CounterpartiesPage />}>
        <Route path="new" element={<CounterpartyPanelRoute mode="create" />} />
        <Route path=":counterpartyId/edit" element={<CounterpartyPanelRoute mode="edit" />} />
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the list mounted behind a nested create route and closes with Back", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [ACME] })),
  );
  const { router, user } = renderPanel(["/counterparties"]);

  await user.click(await screen.findByRole("button", { name: "Добавить контрагента" }));

  expect(router.state.location.pathname).toBe("/counterparties/new");
  expect(screen.getByText("Acme Ltd")).toBeDefined();
  expect(screen.getByRole("dialog", { name: "Новый контрагент" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Закрыть" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/counterparties"));
});

it("uses the list fallback when a directly entered create panel closes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router } = renderPanel(["/counterparties/new"]);

  fireEvent.click(await screen.findByRole("button", { name: "Закрыть" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(router.state.location.pathname).toBe("/counterparties"));
});

it("shows a not-found state instead of a blank edit form", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [ACME] })),
  );
  renderPanel(["/counterparties/missing/edit"]);

  expect(await screen.findByText("Контрагент не найден")).toBeDefined();
  expect(screen.queryByLabelText("Название")).toBeNull();
});

it("guards a dirty create panel from Back until discard is confirmed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderPanel(["/counterparties", "/counterparties/new"]);

  await user.type(await screen.findByLabelText("Название"), "Acme");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/counterparties/new");
  await user.click(await screen.findByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/counterparties"));
});

it("saves the SSCC section independently and clears its dirty state", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/counterparties/1/sscc") && init?.method === "PUT") {
      return jsonResponse(200, { extensionDigit: 0, nextSerial: 42 });
    }
    if (String(url).endsWith("/counterparties/1/sscc")) {
      return jsonResponse(200, { extensionDigit: 0, nextSerial: 10 });
    }
    return jsonResponse(200, { items: [ACME] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { router, user } = renderPanel(["/counterparties/1/edit"]);

  fireEvent.change(await screen.findByLabelText("Название"), { target: { value: "" } });
  const serial = await screen.findByLabelText("Начальный серийный номер");
  fireEvent.change(serial, { target: { value: "42" } });
  await user.click(screen.getByRole("button", { name: "Сохранить SSCC" }));

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/counterparties/1/sscc",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ extensionDigit: 0, nextSerial: 42 }),
      }),
    ),
  );
  expect(screen.queryByText("Укажите название")).toBeNull();
  fireEvent.change(screen.getByLabelText("Название"), { target: { value: ACME.name } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Закрыть" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/counterparties"));
});

it("treats an unsaved SSCC serial as panel-level dirty state", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).endsWith("/counterparties/1/sscc")
        ? jsonResponse(200, { extensionDigit: 0, nextSerial: 10 })
        : jsonResponse(200, { items: [ACME] }),
    ),
  );
  const { user } = renderPanel(["/counterparties", "/counterparties/1/edit"]);

  fireEvent.change(await screen.findByLabelText("Начальный серийный номер"), {
    target: { value: "11" },
  });
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Закрыть" }),
  );

  expect(await screen.findByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();
});

it("keeps profile values and shows the API message after a failed create", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse(409, { message: "GLN already exists" })
        : jsonResponse(200, { items: [] }),
    ),
  );
  const { user } = renderPanel(["/counterparties/new"]);

  await user.type(await screen.findByLabelText("Название"), "Acme");
  await user.type(screen.getByLabelText("GLN"), "6291041500213");
  await user.click(screen.getByRole("button", { name: "Создать" }));

  expect(await screen.findByText("GLN already exists")).toBeDefined();
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Acme");
});
