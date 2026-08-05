import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps list search state while the create panel uses a nested route", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/products")) return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    }),
  );
  const user = userEvent.setup();
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/catalog" element={<CatalogPage />}>
        <Route path="new" element={<ProductPanelRoute mode="create" />} />
      </Route>,
    ),
    { initialEntries: ["/catalog"] },
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
  await user.type(screen.getByLabelText("Поиск"), "milk");
  await user.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);

  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(await screen.findByRole("dialog", { name: "Новый продукт" })).toBeDefined();
  expect((screen.getByLabelText("Поиск") as HTMLInputElement).value).toBe("milk");
});

it("blocks Back until a dirty product form is explicitly discarded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { items: [] })),
  );
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/catalog" element={<CatalogPage />}>
        <Route path="new" element={<ProductPanelRoute mode="create" />} />
      </Route>,
    ),
    { initialEntries: ["/catalog", "/catalog/new"], initialIndex: 1 },
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

  await user.type(await screen.findByLabelText("Название"), "Milk");
  await router.navigate(-1);

  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(await screen.findByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
  expect(router.state.location.pathname).toBe("/catalog/new");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
