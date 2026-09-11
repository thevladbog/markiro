import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { chzRefreshErrorCodeSchema } from "@markiro/platform-contracts";
import type { ChzSummary } from "@markiro/platform-contracts";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { ChzStatus } from "../src/pages/catalog/national-catalog/ChzStatus.js";
import { CatalogPage } from "../src/pages/catalog/index.js";
import type { ProductDto } from "../src/pages/catalog/api.js";

const legacyProduct: ProductDto = {
  id: "00000000-0000-4000-8000-000000000099",
  gtin14: "04006381333931",
  name: "Молоко",
  productGroup: null,
  chzProductGroupCode: null,
  boxCapacity: null,
  palletBoxCapacity: null,
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
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
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

const errorMessages: Record<
  NonNullable<ChzSummary["lastErrorCode"]>,
  { ru: string; en: string }
> = {
  access_changed: {
    ru: "Доступ к карточке изменился. Проверьте права в ЧЗ.",
    en: "Card access changed. Check permissions in CHZ.",
  },
  integration_unconfigured: {
    ru: "Подключение ЧЗ не настроено.",
    en: "The CHZ connection is not configured.",
  },
  environment_mismatch: {
    ru: "Среда ЧЗ не совпадает со средой сохранённой связи.",
    en: "The CHZ environment differs from the saved link environment.",
  },
  refresh_disabled: {
    ru: "Обновление сведений ЧЗ отключено.",
    en: "CHZ information refresh is disabled.",
  },
  local_gtin_changed: {
    ru: "GTIN товара изменился. Проверьте сохранённую связь.",
    en: "The product GTIN changed. Check the saved link.",
  },
  card_lost_gtin: {
    ru: "Карточка ЧЗ больше не содержит GTIN связи.",
    en: "The CHZ card no longer contains the linked GTIN.",
  },
  card_unavailable: {
    ru: "Связанная карточка недоступна в ЧЗ.",
    en: "The linked card is unavailable in CHZ.",
  },
  photo_unavailable: {
    ru: "Проверка фотографии не завершена; успешная проверка карточки остаётся действительной.",
    en: "The photo check is incomplete; the successful card check remains valid.",
  },
  request_failed: {
    ru: "Запрос проверки не выполнен. Повторите обновление.",
    en: "The check request failed. Retry the refresh.",
  },
  request_timeout: {
    ru: "Время ожидания ответа ЧЗ истекло. Повторите обновление.",
    en: "The CHZ response timed out. Retry the refresh.",
  },
  retry_exhausted: {
    ru: "Попытки проверки исчерпаны. Запустите обновление ещё раз.",
    en: "Check retries are exhausted. Start the refresh again.",
  },
  quota_wait: {
    ru: "Проверка ожидает доступной квоты запросов ЧЗ.",
    en: "The check is waiting for available CHZ request quota.",
  },
  lease_busy: {
    ru: "Другая проверка уже выполняется. Дождитесь её завершения.",
    en: "Another check is running. Wait for it to finish.",
  },
  token_unavailable: {
    ru: "Учётные данные ЧЗ недоступны. Проверьте подключение.",
    en: "CHZ credentials are unavailable. Check the connection.",
  },
  provider_unavailable: {
    ru: "Сервис ЧЗ временно недоступен. Повторите обновление позже.",
    en: "The CHZ service is temporarily unavailable. Retry the refresh later.",
  },
};
it.each(
  (["ru", "en"] as const).flatMap((language) =>
    chzRefreshErrorCodeSchema.options.map((code) => ({ language, code })),
  ),
)(
  "discloses $code safely in $language while retaining good card evidence",
  async ({ language, code }) => {
    await i18n.changeLanguage(language);
    const view = render(
      <ChzStatus summary={{ ...summary, lastOutcome: "error", lastErrorCode: code }} />,
    );
    const disclosure = view.container.querySelector("details");
    if (!disclosure) throw new Error("Missing status disclosure");
    await userEvent
      .setup()
      .click(within(disclosure).getByText(language === "ru" ? "Подробнее" : "Details"));
    expect(within(disclosure).getByText(errorMessages[code][language])).toBeDefined();
    expect(disclosure.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-09T00:00:00.000Z",
    );
    expect(
      screen.getAllByText(language === "ru" ? "Опубликовано" : "Published").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(code)).toBeNull();
  },
);
