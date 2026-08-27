import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { CatalogPage } from "../src/pages/catalog/index.js";
import { ProductPanelRoute } from "../src/pages/catalog/ProductPanelRoute.js";

const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderCreatePanel(initialEntries = ["/catalog", "/catalog/new"]) {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/catalog" element={<CatalogPage />}>
        <Route path="new" element={<ProductPanelRoute mode="create" />} />
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  const user = userEvent.setup();
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
  return { router, user };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps list search state while the create panel uses a nested route", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/products")) return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    }),
  );
  const { router, user } = renderCreatePanel(["/catalog"]);
  await user.type(screen.getByLabelText("Поиск"), "milk");
  await user.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);

  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(await screen.findByRole("dialog", { name: "Новый продукт" })).toBeDefined();
  expect((screen.getByLabelText("Поиск") as HTMLInputElement).value).toBe("milk");
});

it("rasterizes a selected product photo into a canvas preview instead of a DOM URL sink", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 10, height: 5, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:untrusted-preview");
  const { user } = renderCreatePanel();

  await user.upload(
    await screen.findByLabelText("Фотография продукта"),
    new File(["not-really-a-png"], "photo.png", { type: "image/png" }),
  );

  expect(await screen.findByRole("img", { name: "Фотография продукта" })).toBeInstanceOf(
    HTMLCanvasElement,
  );
  expect(objectUrl).not.toHaveBeenCalled();
});

it("blocks Back until a dirty product form is explicitly discarded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderCreatePanel();

  await user.type(await screen.findByLabelText("Название"), "Milk");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(await screen.findByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("localizes the panel close control and dirty confirmation in English", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { user } = renderCreatePanel(["/catalog/new"]);

  await user.type(await screen.findByLabelText("Name"), "Milk");
  await user.click(screen.getByRole("button", { name: "Close" }));

  expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Continue editing" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Discard" })).toBeDefined();
});

it.each([
  [
    "close button",
    async (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByRole("button", { name: "Закрыть" })),
  ],
  ["Escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
  [
    "backdrop",
    async () => {
      const scrim = document.querySelector<HTMLElement>(".mk-side-panel__scrim");
      expect(scrim).not.toBeNull();
      fireEvent.mouseDown(scrim!);
    },
  ],
])("keeps dirty input when %s is cancelled", async (_name, dismiss) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderCreatePanel();

  await user.type(await screen.findByLabelText("Название"), "Milk");
  await dismiss(user);

  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(screen.getByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Milk");
});

it("discards a dirty panel dismissal and returns to the catalog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderCreatePanel();

  await user.type(await screen.findByLabelText("Название"), "Milk");
  await user.click(screen.getByRole("button", { name: "Закрыть" }));
  await user.click(screen.getByRole("button", { name: "Не сохранять" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/catalog"));
  expect(screen.queryByRole("dialog", { name: "Новый продукт" })).toBeNull();
});

it("proceeds with a blocked Back navigation after discarding", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const { router, user } = renderCreatePanel();

  await user.type(await screen.findByLabelText("Название"), "Milk");
  await router.navigate(-1);
  await user.click(await screen.findByRole("button", { name: "Не сохранять" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/catalog"));
});

it("blocks every dismissal and duplicate submit while product creation is pending", async () => {
  let resolveCreate: ((response: Response) => void) | undefined;
  const createResponse = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/products" && init?.method === "POST") return createResponse;
    if (path === "/api/products/gtin-check") {
      return jsonResponse(200, { gtin14: "04006381333931", owner: "own" });
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { router, user } = renderCreatePanel();

  await user.type(await screen.findByLabelText("Название"), "Milk");
  await user.type(screen.getByLabelText("ГТИН"), "4006381333931");
  const submit = screen.getByRole("button", { name: "Создать" });
  await user.click(submit);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/products" && init?.method === "POST",
      ),
    ).toHaveLength(1),
  );

  expect((screen.getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled).toBe(true);
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.click(submit);
  await user.keyboard("{Escape}");
  fireEvent.mouseDown(document.querySelector<HTMLElement>(".mk-side-panel__scrim")!);
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === "/api/products" && init?.method === "POST",
    ),
  ).toHaveLength(1);

  resolveCreate?.(
    jsonResponse(201, {
      id: "p-new",
      gtin14: "04006381333931",
      name: "Milk",
      status: "draft",
    }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/catalog"));
});

it("keeps a failed create panel open and retries all required data", async () => {
  let failing = true;
  const fetchMock = vi.fn(async (url: string) => {
    if (failing) return jsonResponse(500, { message: "Unavailable" });
    return String(url).includes("/candidates")
      ? jsonResponse(200, { candidates: [] })
      : jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { user } = renderCreatePanel(["/catalog/new"]);

  await screen.findByRole("dialog", { name: "Новый продукт" });
  expect(await screen.findByText("Не удалось загрузить данные формы продукта.")).toBeDefined();
  const callsBeforeRetry = fetchMock.mock.calls.length;
  // The catalog page appends filter params to the products path, so match by prefix.
  const requiredPaths = ["/api/products", "/api/counterparties"];
  const matchesPath = (url: unknown, path: string) =>
    String(url) === path || String(url).startsWith(`${path}?`);
  const requiredCallsBeforeRetry = requiredPaths.map(
    (path) => fetchMock.mock.calls.filter(([url]) => matchesPath(url, path)).length,
  );
  failing = false;
  await user.click(screen.getByRole("button", { name: "Повторить" }));

  expect(await screen.findByLabelText("Название")).toBeDefined();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  requiredPaths.forEach((path, index) => {
    expect(fetchMock.mock.calls.filter(([url]) => matchesPath(url, path)).length).toBe(
      requiredCallsBeforeRetry[index]! + 1,
    );
  });
  expect(screen.getByRole("dialog", { name: "Новый продукт" })).toBeDefined();
});

it("renders a translated not-found state instead of an empty edit form", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      String(url).includes("/candidates")
        ? jsonResponse(200, { candidates: [] })
        : jsonResponse(200, { items: [] }),
    ),
  );
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/catalog" element={<CatalogPage />}>
        <Route path=":productId/edit" element={<ProductPanelRoute mode="edit" />} />
      </Route>,
    ),
    { initialEntries: ["/catalog/missing/edit"] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );

  await screen.findByRole("dialog", { name: "Изменить продукт" });
  expect(await screen.findByText("Продукт не найден.")).toBeDefined();
  const panel = screen.getByRole("dialog", { name: "Изменить продукт" });
  expect(within(panel).queryByLabelText("Название")).toBeNull();
});

it("releases a busy-only Back block after an unchanged edit request fails", async () => {
  const product = {
    id: "p1",
    gtin14: "04006381333931",
    name: "Milk",
    productGroup: null,
    boxCapacity: null,
    palletCapacity: null,
    unitPrice: null,
    egaisCode: null,
    shelfLifeDays: null,
    externalRef: null,
    status: "draft",
    defaultCounterpartyId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  let resolveUpdate: ((response: Response) => void) | undefined;
  const updateResponse = new Promise<Response>((resolve) => {
    resolveUpdate = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/products/p1" && init?.method === "PATCH") {
        return updateResponse;
      }
      if (String(url).startsWith("/api/products")) return jsonResponse(200, { items: [product] });
      return jsonResponse(200, { items: [] });
    }),
  );
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/catalog" element={<CatalogPage />}>
        <Route path=":productId/edit" element={<ProductPanelRoute mode="edit" />} />
      </Route>,
    ),
    { initialEntries: ["/catalog", "/catalog/p1/edit"], initialIndex: 1 },
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Сохранить" }));
  await router.navigate(-1);
  expect(router.state.location.pathname).toBe("/catalog/p1/edit");
  resolveUpdate?.(jsonResponse(500, { message: "Update failed" }));
  expect(await screen.findByText("Update failed")).toBeDefined();

  await router.navigate(-1);
  await waitFor(() => expect(router.state.location.pathname).toBe("/catalog"));
});
