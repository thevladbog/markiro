import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import {
  DRAFT_PLAN,
  ADDON,
  PUBLISHED_PLAN,
  PLATFORM_ADMIN_ME,
  SERVICE,
  SUPPORT_ME,
  installCatalogApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("commercial catalog", () => {
  it("groups the platform catalog into plans, add-ons, and services", async () => {
    installCatalogApi();
    renderSaasApp();

    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
    expect(await screen.findByRole("tab", { name: "Тарифы" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Дополнения" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Услуги" })).toBeDefined();
  });

  it("paginates large catalog groups instead of rendering every row", async () => {
    const plans = Array.from({ length: 55 }, (_, index) => ({
      ...structuredClone(PUBLISHED_PLAN),
      id: `plan-version-${index + 1}`,
      catalogItemId: `plan-item-${index + 1}`,
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

  it("submits a custom unit and included custom VAT for a service", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.selectOptions(screen.getByLabelText("Единица учёта"), "__other__");
    await user.type(screen.getByLabelText("Другая единица"), "license");
    await user.selectOptions(screen.getByLabelText("НДС"), "custom");
    await user.type(screen.getByLabelText("Ставка НДС, %"), "12.34");
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
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    await user.selectOptions(screen.getByLabelText("НДС"), "none");
    await user.type(screen.getByLabelText("Код позиции"), "service-no-vat");
    await user.type(screen.getByLabelText("Название на русском"), "Без НДС");
    await user.type(screen.getByLabelText("Название на английском"), "No VAT");
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);

    expect(api.createCalls()[0]?.body).toMatchObject({
      vatRateBps: null,
      vatIncluded: false,
    });
  });

  it("keeps a legacy custom unit visible when editing a draft", async () => {
    const legacyDraft = { ...structuredClone(DRAFT_PLAN), unit: "station" };
    installCatalogApi({ items: [legacyDraft] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));

    expect((screen.getByLabelText("Единица учёта") as HTMLSelectElement).value).toBe("__other__");
    expect((screen.getByLabelText("Другая единица") as HTMLInputElement).value).toBe("station");
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
    expect(within(panel).queryByText(/цен|₽|недоступ/i)).toBeNull();
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
    expect(screen.getAllByRole("option", { name: "Станции" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: /\{\{count\}\}/ })).toBeNull();
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
    await user.type(screen.getByLabelText("Линии"), "0");
    await user.click(screen.getByRole("button", { name: "Сохранить черновик" }));

    expect(await screen.findByText("Введите сумму в формате 0.00")).toBeDefined();
    expect(
      screen.getByText("Введите целое число больше нуля или оставьте поле пустым"),
    ).toBeDefined();
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

    expect(
      await screen.findByText("Введите целое число от 1 до 2147483647 или оставьте поле пустым"),
    ).toBeDefined();
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
          nameRu: "Базовый",
          nameEn: "Basic",
          unit: "month",
          unitPrice: "15000.00",
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
          nameRu: "Дополнительная станция",
          nameEn: "Extra station",
          unit: "station",
          unitPrice: "2500.00",
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

  it("confirms the exact version before publishing and then makes the panel immutable", async () => {
    installCatalogApi({ items: [DRAFT_PLAN] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Открыть Базовый, версия 2" }));
    await user.click(screen.getByRole("button", { name: "Опубликовать версию 2" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText("Версия 2 станет неизменяемой после публикации."),
    ).toBeDefined();
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
