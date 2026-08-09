import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import {
  DRAFT_PLAN,
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
    expect(screen.getByRole("tab", { name: "Тарифы" })).toBeDefined();
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
