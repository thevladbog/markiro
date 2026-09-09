import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ChzSummary } from "@markiro/platform-contracts";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AccessProvider } from "../src/access/context.js";
import "../src/i18n/index.js";
import { CatalogPage } from "../src/pages/catalog/index.js";
import type { ProductDto } from "../src/pages/catalog/api.js";

const legacyProduct: ProductDto = {
  id: "00000000-0000-4000-8000-000000000099",
  gtin14: "04006381333931",
  name: "Молоко",
  productGroup: null,
  chzProductGroupCode: null,
  boxCapacity: null,
  palletCapacity: null,
  unitPrice: null,
  printName: null,
  egaisCode: null,
  shelfLifeDays: null,
  externalRef: null,
  status: "draft",
  archived: false,
  defaultCounterpartyId: null,
  createdAt: "2026-09-09T00:00:00.000Z",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function renderCatalog(products: ProductDto[]) {
  const fetch = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify({ items: String(url).includes("/products") ? products : [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessProvider value={{ roles: ["manager"], capabilities: ["operations.read"] }}>
        <MemoryRouter>
          <CatalogPage />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), fetch };
}
const summary: ChzSummary = {
  linkId: "00000000-0000-4000-8000-000000000088",
  revision: 4,
  statusKeys: ["published"],
  rawStatus: "published",
  rawDetailedStatuses: [],
  lastSuccessAt: "2026-09-09T00:00:00.000Z",
  lastAttemptAt: "2026-09-09T00:00:00.000Z",
  refreshing: false,
  lastOutcome: "ok",
  hasChanges: false,
  lastErrorCode: null,
};
it("does not label a missing legacy response field as an unlinked product", async () => {
  const { fetch } = renderCatalog([legacyProduct]);
  expect(await screen.findByText("Молоко")).toBeDefined();
  expect(screen.getByText("Сведения недоступны")).toBeDefined();
  expect(screen.queryByText("Не связан")).toBeNull();
  expect(fetch.mock.calls.every(([url]) => !url.includes("national-catalog"))).toBe(true);
});
it.each([
  [
    {
      ...summary,
      linkId: null,
      revision: null,
      statusKeys: [],
      lastSuccessAt: null,
      lastOutcome: "never",
    },
    "Не связан",
  ],
  [{ ...summary, statusKeys: [], lastSuccessAt: null, lastOutcome: "never" }, "Ещё не проверен"],
])("distinguishes explicit link state %#", async (chz, label) => {
  renderCatalog([{ ...legacyProduct, chz } as ProductDto]);
  expect(await screen.findByText(label)).toBeDefined();
  expect(screen.queryByText("Сведения недоступны")).toBeNull();
});
it("discloses every status, unknown raw evidence and last good time after photo failure", async () => {
  const { user } = renderCatalog([
    {
      ...legacyProduct,
      chz: {
        ...summary,
        statusKeys: ["published", "moderation", "unknown"],
        rawStatus: "FUTURE_STATUS",
        rawDetailedStatuses: ["provider_detail"],
        lastErrorCode: "photo_unavailable",
        lastOutcome: "error",
        hasChanges: true,
      },
    } as ProductDto,
  ]);
  expect(await screen.findAllByText("Опубликовано")).not.toHaveLength(0);
  await user.click(screen.getByText("Ещё статусов: 2 · Подробнее"));
  expect(screen.getAllByText("На модерации").length).toBeGreaterThan(0);
  expect(screen.getByText("FUTURE_STATUS")).toBeDefined();
  expect(screen.getByText("provider_detail")).toBeDefined();
  expect(document.querySelector('time[datetime="2026-09-09T00:00:00.000Z"]')).not.toBeNull();
  expect(
    screen.getByText("Не удалось проверить фотографию. Статус карточки сохранён."),
  ).toBeDefined();
  expect(screen.getByText("Есть изменения")).toBeDefined();
});
it("matches any CHZ status independently of the Markiro status and preserves other rows", async () => {
  const { user } = renderCatalog([
    {
      ...legacyProduct,
      chz: { ...summary, statusKeys: ["published", "moderation"] },
    } as ProductDto,
    { ...legacyProduct, id: "second", name: "Хлеб", chz: summary } as ProductDto,
  ]);
  expect(await screen.findByText("Хлеб")).toBeDefined();
  await user.click(screen.getByRole("combobox", { name: "Статус ЧЗ" }));
  await user.click(screen.getByRole("option", { name: "На модерации" }));
  expect(screen.queryByText("Хлеб")).toBeNull();
  expect(within(screen.getByRole("table")).getByText("Молоко")).toBeDefined();
});
