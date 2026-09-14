import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLATFORM_ADMIN_ME, installCatalogApi, renderSaasApp } from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("recurring service catalog", () => {
  it("creates a monthly package with exact fixed policies and preview", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(screen.getByRole("button", { name: "Создать позицию" }));
    fireEvent.change(screen.getByLabelText("Код позиции"), { target: { value: "support" } });
    fireEvent.change(screen.getByLabelText("Название на русском"), {
      target: { value: "Сервисное сопровождение" },
    });
    fireEvent.change(screen.getByLabelText("Название на английском"), {
      target: { value: "Service support" },
    });
    fireEvent.change(screen.getByLabelText("Название в документах (RU)"), {
      target: { value: "Абонентское сопровождение" },
    });
    fireEvent.change(screen.getByLabelText("Название в документах (EN)"), {
      target: { value: "Monthly support" },
    });
    await choose("Тип услуги", "Ежемесячный пакет");
    fireEvent.change(screen.getByLabelText("Минут включено"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("Состав услуги"), {
      target: { value: "Консультации и настройка" },
    });
    fireEvent.change(screen.getByLabelText("Состав услуги (EN)"), {
      target: { value: "Consulting and setup" },
    });

    await user.click(screen.getByRole("combobox", { name: "Период пакета" }));
    expect(
      (await screen.findByRole("option", { name: "Год — пока недоступен" })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.getAllByText("Минуты не переносятся на следующий месяц").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByText("Дополнительные работы — только после внешнего согласования").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("180 мин включено")).toBeDefined();
    await choose("Тип услуги", "Разовая услуга");
    expect(screen.queryByLabelText("Минут включено")).toBeNull();
    await choose("Тип услуги", "Ежемесячный пакет");
    expect(screen.getByLabelText("Минут включено")).toHaveProperty("value", "180");
    expect(screen.getByLabelText("Состав услуги")).toHaveProperty(
      "value",
      "Консультации и настройка",
    );
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);

    expect(api.createCalls()[0]?.body).toMatchObject({
      billingMode: "recurring",
      billingPeriod: "month",
      unit: "month",
      service: {
        cadence: "month",
        includedMinutes: 180,
        carryover: "none",
        excessPolicy: "external_approval",
        scopeRu: "Консультации и настройка",
        scopeEn: "Consulting and setup",
      },
    });
  });

  it("keeps one-time service creation on the empty service payload", async () => {
    const api = installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(screen.getByRole("button", { name: "Создать позицию" }));
    fireEvent.change(screen.getByLabelText("Код позиции"), { target: { value: "setup" } });
    fireEvent.change(screen.getByLabelText("Название на русском"), {
      target: { value: "Настройка" },
    });
    fireEvent.change(screen.getByLabelText("Название на английском"), {
      target: { value: "Setup" },
    });
    await user.click(screen.getAllByRole("button", { name: "Создать позицию" })[1]!);
    expect(api.createCalls()[0]?.body).toMatchObject({
      billingMode: "one_time",
      billingPeriod: null,
      service: {},
    });
  });

  it("protects unsaved monthly terms when the drawer is closed", async () => {
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Услуги" }));
    await user.click(screen.getByRole("button", { name: "Создать позицию" }));
    await choose("Тип услуги", "Ежемесячный пакет");
    fireEvent.change(screen.getByLabelText("Минут включено"), { target: { value: "180" } });
    await user.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(screen.getByLabelText("Минут включено")).toHaveProperty("value", "180");
  });
});
