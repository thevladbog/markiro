import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogVersionToCreateInput, type CatalogVersionDto } from "../src/pages/catalog/api.js";
import {
  DRAFT_PLAN,
  ADDON,
  PUBLISHED_PLAN,
  PLATFORM_ADMIN_ME,
  SERVICE,
  SUPPORT_ME,
  installCatalogApi,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function submitMinimalCatalogCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
  await user.type(screen.getByLabelText("Код позиции"), "plan-contract-check");
  await user.type(screen.getByLabelText("Название на русском"), "Проверка контракта");
  await user.type(screen.getByLabelText("Название на английском"), "Contract check");
  await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);
}

describe("commercial catalog", () => {
  it.each(["save", "review"])(
    "locks addon effects during deferred %s and retains the submitted values",
    async (operation) => {
      const api = installCatalogApi({ items: [{ ...ADDON, status: "draft" }] });
      const originalFetch = globalThis.fetch;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const response = await originalFetch(input, init);
          if (init.method === "PATCH") await gate;
          return response;
        }),
      );
      renderSaasApp();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
      await user.click(
        screen.getByRole("button", { name: "Открыть Дополнительная станция, версия 1" }),
      );
      const amount = screen.getByLabelText("Прибавка к квоте 1") as HTMLInputElement;
      await user.clear(amount);
      await user.type(amount, "3");
      await user.click(
        screen.getByRole("button", {
          name: operation === "save" ? "Сохранить черновик" : "Опубликовать версию 1",
        }),
      );
      await waitFor(() => expect(api.patchCalls()).toHaveLength(1));
      try {
        expect(amount.disabled).toBe(true);
        expect(
          (screen.getByRole("button", { name: "Добавить эффект" }) as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
          (screen.getByRole("combobox", { name: "Тип эффекта 1" }) as HTMLSelectElement).disabled,
        ).toBe(true);
      } finally {
        release();
      }
      if (operation === "save") await screen.findByText("Черновик сохранён");
      else await screen.findByRole("alertdialog");
      await waitFor(() =>
        expect((screen.getByLabelText("Прибавка к квоте 1") as HTMLInputElement).value).toBe("3"),
      );
      expect(api.patchCalls()[0]?.body).toMatchObject({
        addon: { effects: [{ key: "stations", quotaIncrement: 3 }] },
      });
    },
  );

  it.each([
    {
      price: "100.00",
      rate: 2000,
      included: false,
      invoice: "120.00",
      offer: "120.00",
      vat: "20.00",
    },
    {
      price: "100.00",
      rate: 2000,
      included: true,
      invoice: "100.00",
      offer: "100.00",
      vat: "16.66",
    },
    { price: "100.00", rate: 0, included: false, invoice: "100.00", offer: "100.00", vat: "0.00" },
    {
      price: "100.00",
      rate: null,
      included: false,
      invoice: "100.00",
      offer: "100.00",
      vat: "0.00",
    },
    { price: "0.03", rate: 2000, included: false, invoice: "0.03", offer: "0.04", vat: "0.00" },
  ])(
    "shows exact publication and live payable amounts %j",
    async ({ price, rate, included, invoice, offer, vat }) => {
      installCatalogApi({
        items: [{ ...DRAFT_PLAN, unitPrice: price, vatRateBps: rate, vatIncluded: included }],
        taxPolicy:
          rate === null
            ? { kind: "without_vat", regime: "npd" }
            : {
                kind: "vat",
                regime: "other",
                allowedRatesBps: [rate],
                defaultRateBps: rate,
                defaultIncluded: included,
              },
      });
      renderSaasApp();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
      const live = screen.getByRole("complementary", { name: "Эффект версии" });
      expect(live.textContent).toContain(`К оплате`);
      expect(live.textContent).toContain(`${invoice} RUB`);
      expect(live.textContent).toContain(`${offer} RUB`);
      await user.click(screen.getByRole("button", { name: "Опубликовать версию 2" }));
      const review = await screen.findByRole("alertdialog");
      expect(review.textContent).toContain(`Цена: ${price} RUB`);
      expect(review.textContent).toContain(`${vat} RUB`);
      expect(review.textContent).toContain(`К оплате`);
      expect(review.textContent).toContain(`${invoice} RUB`);
      expect(review.textContent).toContain(`${offer} RUB`);
      if (invoice !== offer || included) {
        expect(review.textContent).toContain("Счёт");
        expect(review.textContent).toContain("Предложение");
      }
      if (rate === null) expect(review.textContent).toContain("Без НДС");
      if (rate === 0) expect(review.textContent).toContain("0%");
    },
  );

  it("updates addon effect summary before saving", async () => {
    installCatalogApi({ items: [{ ...ADDON, status: "draft" }] });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(
      screen.getByRole("button", { name: "Открыть Дополнительная станция, версия 1" }),
    );
    await user.clear(screen.getByLabelText("Прибавка к квоте 1"));
    await user.type(screen.getByLabelText("Прибавка к квоте 1"), "3");
    expect(screen.getByText("+3 станции")).toBeDefined();
  });

  it("creates an annual plan with explicit zero finite and unlimited quotas", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.type(screen.getByLabelText("Код позиции"), "plan-year");
    await user.type(screen.getByLabelText("Название на русском"), "Годовой");
    await user.type(screen.getByLabelText("Название на английском"), "Annual");
    await chooseOption(user, "Период лицензии", "Год");
    await user.clear(screen.getByLabelText("Цена за единицу"));
    await user.type(screen.getByLabelText("Цена за единицу"), "69000.00");
    await chooseOption(user, "Киоски: режим", "Нет");
    await chooseOption(user, "Линии: режим", "Ограничено");
    await user.type(screen.getByLabelText("Линии"), "2");
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);
    expect(api.createCalls()[0]?.body).toMatchObject({
      billingPeriod: "year",
      unit: "year",
      unitPrice: "69000.00",
      plan: { maxKiosks: 0, maxLines: 2, maxStations: null },
    });
  });

  it("saves an annual draft and rejects an empty limited quota", async () => {
    const api = installCatalogApi();
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await chooseOption(user, "Период лицензии", "Год");
    await user.clear(screen.getByLabelText("Линии"));
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(api.patchCalls()).toHaveLength(0);
    expect(await screen.findByText("Укажите положительное целое количество.")).toBeDefined();
    await user.type(screen.getByLabelText("Линии"), "4");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(api.patchCalls()[0]?.body).toMatchObject({
      billingPeriod: "year",
      unit: "year",
      plan: { maxLines: 4 },
    });
  });

  it("refreshes a competing draft price before a second publication confirmation", async () => {
    installCatalogApi({ items: [DRAFT_PLAN], stalePublishPrice: "79000.00" });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.click(screen.getByRole("button", { name: "Опубликовать версию 2" }));
    const first = await screen.findByRole("alertdialog");
    expect(first.textContent).toContain("15000.00");
    await user.click(within(first).getByRole("button", { name: "Опубликовать версию 2" }));
    await screen.findByText(/Условия изменились/);
    const refreshed = await screen.findByRole("alertdialog");
    expect(refreshed.textContent).toContain("79000.00");
    expect(refreshed.textContent).not.toContain("15000.00");
  });

  it("refreshes the payable total and period together after stale publication", async () => {
    installCatalogApi({
      items: [{ ...DRAFT_PLAN, unitPrice: "100.00", vatRateBps: 2000, vatIncluded: false }],
      stalePublishPrice: "200.00",
      stalePublishPeriod: "year",
    });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.click(screen.getByRole("button", { name: "Опубликовать версию 2" }));
    const first = await screen.findByRole("alertdialog");
    expect(first.textContent).toContain("120.00 RUB");
    await user.click(within(first).getByRole("button", { name: "Опубликовать версию 2" }));
    await screen.findByText(/Условия изменились/);
    const refreshed = await screen.findByRole("alertdialog");
    expect(refreshed.textContent).toContain("240.00 RUB");
    expect(refreshed.textContent).toContain("Год");
    expect(refreshed.textContent).not.toContain("120.00 RUB");
    const live = screen.getByRole("complementary", { name: "Эффект версии" });
    expect(live.textContent).toContain("240.00 RUB");
    expect(live.textContent).toContain("Год");
  });

  it("rejects a malformed catalog success body at the browser boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/settings/demo-plan")) {
          return jsonResponse(200, { catalogVersionId: null });
        }
        if (url.endsWith("/api/platform/catalog/items")) {
          return jsonResponse(200, {
            items: [{ ...DRAFT_PLAN, status: "active" }],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    renderSaasApp();

    expect(await screen.findByText("Не удалось загрузить каталог.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Открыть Базовый, версия 2" })).toBeNull();
  });

  it("groups the platform catalog into plans, add-ons, and services", async () => {
    installCatalogApi();
    renderSaasApp();

    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
    expect(
      screen.getByText("Версии тарифов, дополнений и услуг для коммерческих документов."),
    ).toBeDefined();
    expect(await screen.findByRole("region", { name: "Версии каталога" })).toBeDefined();
    expect(await screen.findByRole("tab", { name: "Тарифы" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Дополнения" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Услуги" })).toBeDefined();
  });

  it("switches catalog groups from the keyboard", async () => {
    installCatalogApi();
    renderSaasApp();
    const user = userEvent.setup();

    const plans = await screen.findByRole("tab", { name: "Тарифы" });
    plans.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Дополнения" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("paginates large catalog groups instead of rendering every row", async () => {
    const plans = Array.from({ length: 55 }, (_, index) => ({
      ...structuredClone(PUBLISHED_PLAN),
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      catalogItemId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      catalogItemCode: `plan-${index + 1}`,
      nameRu: `Тариф ${index + 1}`,
      nameEn: `Plan ${index + 1}`,
    }));
    installCatalogApi({ items: plans });
    renderSaasApp();
    const user = userEvent.setup();

    expect(await screen.findByText("Страница 1 из 2")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /Открыть Тариф/ })).toHaveLength(50);
    expect(screen.queryByRole("button", { name: "Открыть Тариф 51, версия 1" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Следующая" }));

    expect(await screen.findByText("Страница 2 из 2")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /Открыть Тариф/ })).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Открыть Тариф 51, версия 1" })).toBeDefined();
  });

  it("opens a create form and creates a new catalog item", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.type(screen.getByLabelText("Код позиции"), "plan-pro");
    await user.type(screen.getByLabelText("Название на русском"), "Профи");
    await user.type(screen.getByLabelText("Название на английском"), "Pro");
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);
    expect(await screen.findByRole("region", { name: "Версия 1 · Профи" })).toBeDefined();
    expect(api.items()).toHaveLength(1);
  });

  it.each([
    [409, "Позиция с таким кодом уже существует или недоступна"],
    [
      {
        status: 409,
        body: { message: "raw-server-conflict-must-not-render", zod: "must-not-render" },
        headers: { "x-request-id": "41111111-1111-4111-8111-111111111111" },
      },
      "Не удалось создать позицию.",
    ],
  ])(
    "uses conflict copy only for a valid domain create failure %#",
    async (response, expectedMessage) => {
      installCatalogApi({
        me: PLATFORM_ADMIN_ME,
        items: [],
        createResponses: [response],
      });
      renderSaasApp();
      const user = userEvent.setup();

      await submitMinimalCatalogCreate(user);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(expectedMessage);
      expect(alert.textContent).not.toMatch(/raw-server-conflict|zod|must-not-render/i);
    },
  );

  it("submits a custom service unit and seller-allowed VAT", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await chooseOption(user, "Единица учёта", "Другое");
    await user.type(screen.getByLabelText("Другая единица"), "license");
    await chooseOption(user, "НДС", "НДС 12.34%");
    await user.type(screen.getByLabelText("Код позиции"), "service-license");
    await user.type(screen.getByLabelText("Название на русском"), "Лицензия");
    await user.type(screen.getByLabelText("Название на английском"), "License");
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);

    expect(api.createCalls()[0]?.body).toMatchObject({
      unit: "license",
      vatRateBps: 1234,
      vatIncluded: true,
    });
  });

  it("submits without VAT explicitly", async () => {
    const api = installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [],
      taxPolicy: { kind: "without_vat", regime: "npd" },
    });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await chooseOption(user, "НДС", "Без НДС");
    await user.type(screen.getByLabelText("Код позиции"), "service-no-vat");
    await user.type(screen.getByLabelText("Название на русском"), "Без НДС");
    await user.type(screen.getByLabelText("Название на английском"), "No VAT");
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);

    expect(api.createCalls()[0]?.body).toMatchObject({
      vatRateBps: null,
      vatIncluded: false,
    });
  });

  it("uses structured period instead of a legacy custom license unit", async () => {
    const legacyDraft = { ...structuredClone(DRAFT_PLAN), unit: "station" };
    installCatalogApi({ items: [legacyDraft] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));

    expect(screen.getByRole("combobox", { name: "Период лицензии" }).textContent).toContain(
      "Месяц",
    );
    expect(screen.queryByLabelText("Другая единица")).toBeNull();
  });

  it("shows and submits explicit add-on entitlement effects", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(screen.getByRole("button", { name: "Создать позицию" }));

    expect(screen.getByRole("group", { name: "Что расширяет дополнение" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Тип эффекта 1" }).textContent).toContain(
      "Станции",
    );
    expect((screen.getByLabelText("Прибавка к квоте 1") as HTMLInputElement).value).toBe("1");
    await chooseOption(user, "Тип эффекта 1", "Киоски");
    await user.clear(screen.getByLabelText("Прибавка к квоте 1"));
    await user.type(screen.getByLabelText("Прибавка к квоте 1"), "3");
    await user.click(screen.getByRole("button", { name: "Добавить эффект" }));
    await chooseOption(user, "Тип эффекта 2", "Публичный API");
    await user.type(screen.getByLabelText("Код позиции"), "addon-kiosk");
    await user.type(screen.getByLabelText("Название на русском"), "Киоски");
    await user.type(screen.getByLabelText("Название на английском"), "Kiosks");
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);

    expect(api.createCalls()[0]?.body).toMatchObject({
      addon: {
        effects: [
          { key: "kiosks", quotaIncrement: 3 },
          { key: "publicApi", featureEnabled: true },
        ],
      },
    });
  });

  it("submits complete plan commercial terms", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.type(screen.getByLabelText("Код позиции"), "plan-complete");
    await user.type(screen.getByLabelText("Название на русском"), "Полный тариф");
    await user.type(screen.getByLabelText("Название на английском"), "Complete plan");
    await user.type(screen.getByLabelText("Описание на русском"), "Для производства");
    await user.type(screen.getByLabelText("Описание на английском"), "For production");
    await chooseOption(user, "Линии: режим", "Ограничено");
    await user.type(screen.getByLabelText("Линии"), "10");
    await user.clear(screen.getByLabelText("Дней демо"));
    await user.type(screen.getByLabelText("Дней демо"), "30");
    await user.click(screen.getByLabelText("Редактор этикеток"));
    await user.click(screen.getByLabelText("Публичный API"));
    await user.click(screen.getByLabelText("Работа с палетами"));
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);

    expect(api.createCalls()[0]?.body).toMatchObject({
      descriptionRu: "Для производства",
      descriptionEn: "For production",
      plan: {
        maxLines: 10,
        demoDurationDays: 30,
        labelEditorEnabled: true,
        publicApiEnabled: true,
        palletsEnabled: true,
      },
    });
  });

  it("clones an immutable version into the next draft", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [PUBLISHED_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Новая версия" }));

    expect(api.createCalls()).toHaveLength(1);
    expect(api.createCalls()[0]?.itemCode).toBe("plan-basic");
    expect(api.createCalls()[0]?.body).toMatchObject({
      nameRu: "Базовый",
      unit: "month",
      unitPrice: "15000.00",
      vatRateBps: 2000,
      vatIncluded: true,
      plan: PUBLISHED_PLAN.plan,
    });
    expect(await screen.findByRole("region", { name: "Версия 2 · Базовый" })).toBeDefined();
  });

  it("refuses to invent missing financial terms while cloning", () => {
    const partiallyRedactedPlan: CatalogVersionDto = structuredClone(PUBLISHED_PLAN);
    delete partiallyRedactedPlan.vatRateBps;
    delete partiallyRedactedPlan.vatIncluded;

    expect(() => catalogVersionToCreateInput(partiallyRedactedPlan)).toThrow(
      "catalog_version_financial_terms_missing",
    );
  });

  it("clones add-on effects and one-time service terms", async () => {
    const addonApi = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [ADDON] });
    const addonRender = renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(
      screen.getByRole("button", { name: "Открыть Дополнительная станция, версия 1" }),
    );
    await user.click(screen.getByRole("button", { name: "Новая версия" }));
    expect(addonApi.createCalls()[0]?.body).toMatchObject({
      billingMode: "recurring",
      addon: { effects: [{ key: "stations", quotaIncrement: 1 }] },
    });
    addonRender.unmount();

    const serviceApi = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [SERVICE] });
    renderSaasApp();
    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(screen.getByRole("button", { name: "Открыть Внедрение, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Новая версия" }));
    expect(serviceApi.createCalls()[0]?.body).toMatchObject({
      billingMode: "one_time",
      billingPeriod: null,
      unit: "project",
      service: {},
    });
  });

  it("reports a clone failure without replacing the source version", async () => {
    const api = installCatalogApi({
      me: PLATFORM_ADMIN_ME,
      items: [PUBLISHED_PLAN],
      createResponses: [500],
    });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Новая версия" }));
    expect(await screen.findByText("Не удалось создать новую версию.")).toBeDefined();
    expect(api.items()).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Версия 1 · Базовый" })).toBeDefined();
  });

  it("closes a clean catalog drawer from its backdrop", async () => {
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    expect(screen.getByRole("dialog", { name: "Новая позиция каталога" })).toBeDefined();
    const scrim = document.querySelector(".mk-side-panel__scrim");
    expect(scrim).not.toBeNull();
    await user.click(scrim!);
    expect(screen.queryByRole("dialog", { name: "Новая позиция каталога" })).toBeNull();
  });

  it("protects dirty catalog forms before backdrop dismissal", async () => {
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.type(screen.getByLabelText("Код позиции"), "dirty-item");
    await user.click(document.querySelector(".mk-side-panel__scrim")!);

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Новая позиция каталога" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
    expect(screen.getByRole("dialog", { name: "Новая позиция каталога" })).toBeDefined();
  });

  it("opens a catalog version when clicking any cell in its row", async () => {
    installCatalogApi({ items: [PUBLISHED_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("cell", { name: "1" }));

    expect(await screen.findByRole("region", { name: "Версия 1 · Базовый" })).toBeDefined();
  });

  it("closes the create panel before switching tabs or opening a row", async () => {
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [PUBLISHED_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    expect(screen.getByRole("region", { name: "Новая позиция каталога" })).toBeDefined();

    await user.click(screen.getByRole("tab", { name: "Дополнения" }));
    expect(screen.queryByRole("region", { name: "Новая позиция каталога" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Тарифы" }));
    await user.click(await screen.findByRole("cell", { name: "1" }));
    expect(screen.queryByRole("region", { name: "Новая позиция каталога" })).toBeNull();
    expect(await screen.findByRole("region", { name: "Версия 1 · Базовый" })).toBeDefined();
  });

  it("archives a retired catalog position from its open row", async () => {
    const retired = { ...structuredClone(SERVICE), status: "retired" as const };
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [retired] });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(await screen.findByRole("button", { name: "Открыть Внедрение, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Архивировать позицию" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Архивировать позицию" }));
    expect(await screen.findByText("Версий этого типа пока нет")).toBeDefined();
  });

  it("shows support names and effects without a price label or placeholder", async () => {
    const redactedPlan: CatalogVersionDto = structuredClone(PUBLISHED_PLAN);
    delete redactedPlan.unitPrice;
    delete redactedPlan.vatRateBps;
    delete redactedPlan.vatIncluded;
    const supportItems = [redactedPlan];
    installCatalogApi({ me: SUPPORT_ME, items: supportItems });
    renderSaasApp();

    await userEvent.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 1" }));
    const panel = screen.getByRole("region", { name: "Версия 1 · Базовый" });
    expect(within(panel).getByText("2 линии")).toBeDefined();
    expect(within(panel).queryByText(/цена|стоимость|₽|недоступ/i)).toBeNull();
  });

  it("edits the real discriminated plan draft fields", async () => {
    installCatalogApi({ items: [DRAFT_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    const name = screen.getByLabelText("Название на русском");
    await user.clear(name);
    await user.type(name, "Производственный");
    const lines = screen.getByLabelText("Линии");
    await user.clear(lines);
    await user.type(lines, "4");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByDisplayValue("Производственный")).toBeDefined();
    expect(screen.getByDisplayValue("4")).toBeDefined();
    expect(screen.getByText("Черновик сохранён")).toBeDefined();
  });

  it("preserves every distinct add-on effect while supporting accessible add and remove", async () => {
    const draftAddon: CatalogVersionDto = {
      ...structuredClone(ADDON),
      status: "draft",
      addon: {
        effects: [
          { key: "stations", quotaIncrement: 2 },
          { key: "publicApi", featureEnabled: true },
        ],
      },
    };
    const api = installCatalogApi({ items: [draftAddon] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(
      screen.getByRole("button", { name: "Открыть Дополнительная станция, версия 1" }),
    );
    expect(screen.getAllByRole("combobox", { name: /Тип эффекта/ })).toHaveLength(2);
    await user.click(screen.getAllByRole("combobox", { name: /Тип эффекта/ })[0]!);
    expect(screen.getAllByRole("option", { name: "Станции" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: /\{\{count\}\}/ })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Добавить эффект" }));
    expect(screen.getAllByRole("combobox", { name: /Тип эффекта/ })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Удалить эффект 3" }));
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(api.items()[0]?.addon?.effects).toEqual([
      { key: "stations", quotaIncrement: 2 },
      { key: "publicApi", featureEnabled: true },
    ]);
  });

  it("blocks invalid money, quota, and add-on increments before an API write", async () => {
    const planApi = installCatalogApi({ items: [DRAFT_PLAN] });
    const planRender = renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.clear(screen.getByLabelText("Цена за единицу"));
    await user.type(screen.getByLabelText("Цена за единицу"), "15000");
    await user.clear(screen.getByLabelText("Линии"));
    await user.type(screen.getByLabelText("Линии"), "-1");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Введите сумму в формате 0.00")).toBeDefined();
    expect(screen.getByText("Введите целое число больше нуля")).toBeDefined();
    expect(planApi.items()[0]?.unitPrice).toBe("15000.00");
    planRender.unmount();

    const draftAddon: CatalogVersionDto = { ...structuredClone(ADDON), status: "draft" };
    const addonApi = installCatalogApi({ items: [draftAddon] });
    renderSaasApp();
    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(
      screen.getByRole("button", { name: "Открыть Дополнительная станция, версия 1" }),
    );
    await user.clear(screen.getByLabelText("Прибавка к квоте 1"));
    await user.type(screen.getByLabelText("Прибавка к квоте 1"), "0");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Введите целое число больше нуля")).toBeDefined();
    expect(addonApi.items()[0]?.addon?.effects).toEqual([{ key: "stations", quotaIncrement: 1 }]);
  });

  it("blocks plan quotas above the PostgreSQL integer limit and accepts the exact boundary", async () => {
    const api = installCatalogApi({ items: [DRAFT_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    const lines = screen.getByLabelText("Линии");
    await user.clear(lines);
    await user.type(lines, "2147483648");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Введите целое число от 1 до 2147483647")).toBeDefined();
    expect(api.patchCalls()).toEqual([]);
    expect(api.items()[0]?.plan?.maxLines).toBe(2);

    await user.clear(lines);
    await user.type(lines, "2147483647");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Черновик сохранён")).toBeDefined();
    expect(api.patchCalls()).toEqual([
      {
        method: "PATCH",
        path: "/api/platform/catalog/items/plan-basic/versions/11111111-1111-4111-8111-111111111111",
        body: {
          billingPeriod: "month",
          documentNameRu: null,
          documentNameEn: null,
          subject: "software_license",
          sellerPolicyRevision: 1,
          descriptionRu: "Для одной площадки",
          descriptionEn: "For one site",
          nameRu: "Базовый",
          nameEn: "Basic",
          unit: "month",
          unitPrice: "15000.00",
          vatRateBps: 2000,
          vatIncluded: true,
          plan: {
            maxLines: 2147483647,
            maxStations: 3,
            maxKiosks: 1,
            maxCabinetUsers: 5,
            demoDurationDays: 14,
            labelEditorEnabled: true,
            publicApiEnabled: false,
            palletsEnabled: false,
          },
        },
      },
    ]);
    expect(api.items()[0]?.plan?.maxLines).toBe(2147483647);
  });

  it("blocks add-on increments above the PostgreSQL integer limit and accepts the boundary", async () => {
    const draftAddon: CatalogVersionDto = { ...structuredClone(ADDON), status: "draft" };
    const api = installCatalogApi({ items: [draftAddon] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Дополнения" }));
    await user.click(
      screen.getByRole("button", { name: "Открыть Дополнительная станция, версия 1" }),
    );
    const increment = screen.getByLabelText("Прибавка к квоте 1");
    await user.clear(increment);
    await user.type(increment, "2147483648");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Введите целое число от 1 до 2147483647")).toBeDefined();
    expect(api.patchCalls()).toEqual([]);
    expect(api.items()[0]?.addon?.effects).toEqual([{ key: "stations", quotaIncrement: 1 }]);

    await user.clear(increment);
    await user.type(increment, "2147483647");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Черновик сохранён")).toBeDefined();
    expect(api.patchCalls()).toEqual([
      {
        method: "PATCH",
        path: "/api/platform/catalog/items/addon-station/versions/41111111-1111-4111-8111-111111111111",
        body: {
          billingPeriod: "month",
          documentNameRu: null,
          documentNameEn: null,
          subject: "software_license",
          sellerPolicyRevision: 1,
          descriptionRu: null,
          descriptionEn: null,
          nameRu: "Дополнительная станция",
          nameEn: "Extra station",
          unit: "month",
          unitPrice: "2500.00",
          vatRateBps: 2000,
          vatIncluded: true,
          addon: { effects: [{ key: "stations", quotaIncrement: 2147483647 }] },
        },
      },
    ]);
    expect(api.items()[0]?.addon?.effects).toEqual([
      { key: "stations", quotaIncrement: 2147483647 },
    ]);
  });

  it("replaces stale save success with a localized conflict in the live status", async () => {
    installCatalogApi({ items: [DRAFT_PLAN], saveStatuses: [200, 409] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    expect(await screen.findByText("Черновик сохранён")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    const liveStatus = screen.getByRole("status", { name: "Статус операции с версией" });
    expect(
      await within(liveStatus).findByText("Версия уже изменилась. Обновите каталог."),
    ).toBeDefined();
    expect(within(liveStatus).queryByText("Черновик сохранён")).toBeNull();
  });

  it("uses the safe generic save error for a malformed 409 envelope", async () => {
    installCatalogApi({
      items: [DRAFT_PLAN],
      saveStatuses: [
        {
          status: 409,
          body: { message: "raw-save-conflict-must-not-render", zod: "must-not-render" },
          headers: { "x-request-id": "51111111-1111-4111-8111-111111111111" },
        },
      ],
    });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    const liveStatus = screen.getByRole("status", { name: "Статус операции с версией" });
    expect(await within(liveStatus).findByText("Не удалось сохранить черновик.")).toBeDefined();
    expect(liveStatus.textContent).not.toMatch(/raw-save-conflict|zod|must-not-render/i);
    expect(within(liveStatus).queryByText("Версия уже изменилась. Обновите каталог.")).toBeNull();
  });

  it("announces a localized default-demo conflict without changing the selected version", async () => {
    installCatalogApi({ items: [PUBLISHED_PLAN], defaultStatuses: [409] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Сделать версию 1 демо по умолчанию" }));

    const liveStatus = screen.getByRole("status", { name: "Статус операции с версией" });
    expect(
      await within(liveStatus).findByText("Демо-план уже изменён. Обновите каталог."),
    ).toBeDefined();
    expect(screen.queryByText("Демо по умолчанию")).toBeNull();
  });

  it("uses the safe generic demo-plan error for a malformed 409 envelope", async () => {
    installCatalogApi({
      items: [PUBLISHED_PLAN],
      defaultStatuses: [
        {
          status: 409,
          body: { message: "raw-demo-conflict-must-not-render", zod: "must-not-render" },
          headers: { "x-request-id": "61111111-1111-4111-8111-111111111111" },
        },
      ],
    });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Сделать версию 1 демо по умолчанию" }));

    const liveStatus = screen.getByRole("status", { name: "Статус операции с версией" });
    expect(await within(liveStatus).findByText("Не удалось назначить демо-план.")).toBeDefined();
    expect(liveStatus.textContent).not.toMatch(/raw-demo-conflict|zod|must-not-render/i);
    expect(within(liveStatus).queryByText("Демо-план уже изменён. Обновите каталог.")).toBeNull();
  });

  it("confirms the exact version before publishing and then makes the panel immutable", async () => {
    installCatalogApi({ items: [DRAFT_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.click(screen.getByRole("button", { name: "Опубликовать версию 2" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Версия 2 станет неизменяемой после публикации/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Опубликовать версию 2" }));

    expect(await screen.findByText("Опубликованная версия не редактируется.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Сохранить черновик" })).toBeNull();
    const liveStatus = screen.getByRole("status", { name: "Статус операции с версией" });
    expect(within(liveStatus).getByText("Версия 2 опубликована")).toBeDefined();
  });

  it("switches the exact published plan version used for new demos", async () => {
    installCatalogApi({ items: [PUBLISHED_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 1" }));
    await user.click(screen.getByRole("button", { name: "Сделать версию 1 демо по умолчанию" }));

    expect(await screen.findByText("Демо по умолчанию")).toBeDefined();
  });
});
