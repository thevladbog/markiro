import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import {
  DRAFT_PLAN,
  ADDON,
  PUBLISHED_PLAN,
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
