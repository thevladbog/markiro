import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { AccessProvider } from "../src/access/context.js";
import { profileSchema } from "../src/pages/catalog/regulatory/api.js";
import { CatalogPage } from "../src/pages/catalog/index.js";
import { ProductPanelRoute } from "../src/pages/catalog/ProductPanelRoute.js";
import { profile, product, readiness, PRODUCT_ID } from "./catalog-regulatory-fixtures.js";

function mount(mode: "create" | "edit" = "edit", readonly = false) {
  const requests: string[] = [];
  const writes: { path: string; body: unknown }[] = [];
  let exists = mode === "edit";
  let failingPath: string | null = null;
  let current = profileSchema.parse(profile());
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      requests.push(path);
      if (failingPath && path.startsWith(failingPath))
        return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 });
      if (path.endsWith("gtin-check")) return json({ gtin14: product().gtin14, owner: "unknown" });
      if (init?.method && init.method !== "GET") {
        const body = JSON.parse(String(init.body)) as {
          values?: { attributeId: string; value: unknown }[];
        };
        writes.push({ path, body });
        if (path === "/api/products") {
          exists = true;
          return json(product());
        }
        if (path.endsWith("regulatory-attributes")) {
          current = profileSchema.parse({
            ...current,
            binding: { ...current.binding, revision: 5 },
            values: current.values.map((row) => ({
              ...row,
              ...body.values?.find((v) => v.attributeId === row.attributeId),
            })),
          });
          return json(current);
        }
        return json(product());
      }
      if (path.endsWith("regulatory-profile")) return json(current);
      if (path.endsWith("/readiness")) return json(readiness);
      if (path.includes("/chz-product-groups"))
        return json({ items: [{ code: 23, name: "Соки" }] });
      if (path === "/api/products" || path.startsWith("/api/products?"))
        return json({ items: exists ? [product()] : [] });
      return json({ items: [] });
    }),
  );
  const router = createMemoryRouter(
    [
      {
        path: "/catalog",
        element: <CatalogPage />,
        children: [
          { path: "new", element: <ProductPanelRoute mode="create" /> },
          { path: ":productId/edit", element: <ProductPanelRoute mode="edit" /> },
        ],
      },
    ],
    {
      initialEntries: [
        "/catalog",
        mode === "create" ? "/catalog/new" : `/catalog/${PRODUCT_ID}/edit`,
      ],
      initialIndex: 1,
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AccessProvider
        value={{
          roles: ["manager"],
          capabilities: readonly
            ? [CABINET_CAPABILITY.OPERATIONS_READ]
            : [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
        }}
      >
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return {
    router,
    requests,
    writes,
    client,
    failRead: (path: string) => {
      failingPath = path;
    },
    user: userEvent.setup(),
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps creation compact, then opens the saved product to complete category attributes", async () => {
  const { user, requests, router } = mount("create");
  await user.type(await screen.findByLabelText("Название"), "Сок яблочный");
  await user.type(screen.getByLabelText("ГТИН"), product().gtin14);
  expect(requests.some((path) => /regulatory|readiness/.test(path))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Создать" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/catalog/${PRODUCT_ID}/edit`));
  expect(await screen.findByRole("heading", { name: "Характеристики категории" })).toBeDefined();
});
it("guards dirty category fields on close and blocks a base save from discarding them", async () => {
  const { user, router, writes } = mount();
  const field = await screen.findByLabelText("Объём");
  await user.clear(field);
  await user.type(field, "750");
  expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", true);
  expect(document.querySelector("form form")).toBeNull();
  await user.click(
    within(screen.getByRole("dialog", { name: "Изменить продукт" })).getByRole("button", {
      name: "Закрыть",
    }),
  );
  await user.click(await screen.findByRole("button", { name: "Продолжить редактирование" }));
  expect(screen.getByLabelText("Объём")).toHaveProperty("value", "750");
  await user.click(screen.getByRole("button", { name: "Сохранить характеристики" }));
  await waitFor(() =>
    expect(writes.filter((w) => w.path.endsWith("regulatory-attributes"))).toHaveLength(1),
  );
  expect(router.state.location.pathname).toBe(`/catalog/${PRODUCT_ID}/edit`);
  expect(screen.getByLabelText("Объём")).toHaveProperty("value", "750");
});
it("does not display or clear irrelevant EGAIS data when saving juice production fields", async () => {
  const { user, writes } = mount();
  await screen.findByLabelText("Объём");
  expect(screen.queryByLabelText("Код ЕГАИС")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(writes.find((w) => w.path === `/api/products/${PRODUCT_ID}`)).toBeDefined(),
  );
  expect(writes.find((w) => w.path === `/api/products/${PRODUCT_ID}`)?.body).not.toHaveProperty(
    "egaisCode",
  );
});

it("opens the product card and category readiness for an operator with read-only access", async () => {
  const { router, user, writes } = mount("edit", true);
  await router.navigate("/catalog");
  await user.click(await screen.findByRole("link", { name: "Сок яблочный" }));
  expect(await screen.findByRole("dialog", { name: "Карточка товара" })).toBeDefined();
  expect(await screen.findByRole("heading", { name: "Характеристики категории" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Сменить категорию" })).toBeNull();
  expect(writes).toEqual([]);
});

it.each(["/api/products?", "/api/counterparties"])(
  "retains draft and close guard when the parent %s query fails in background",
  async (path) => {
    const { user, client, failRead } = mount();
    const field = await screen.findByLabelText("Объём");
    await user.clear(field);
    await user.type(field, "825");
    failRead(path);
    await client.invalidateQueries({
      queryKey: [path.includes("products") ? "products" : "counterparties"],
    });
    expect(screen.getByLabelText("Объём")).toHaveProperty("value", "825");
    await user.click(
      within(screen.getByRole("dialog", { name: "Изменить продукт" })).getByRole("button", {
        name: "Закрыть",
      }),
    );
    expect(await screen.findByRole("alertdialog")).toBeDefined();
  },
);
