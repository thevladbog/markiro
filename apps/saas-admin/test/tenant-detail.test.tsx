import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PLATFORM_ADMIN_ME,
  SUPPORT_ME,
  TENANT_DETAIL,
  TENANT_ID,
  installTenantApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tenant subscription detail", () => {
  it("renders exact current, scheduled, add-on, usage, and reasoned history facts", async () => {
    installTenantApi();
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.getByText("Базовый · plan-basic · версия 1")).toBeDefined();
    expect(screen.getByText("Производственный · plan-production · версия 3")).toBeDefined();
    expect(screen.getAllByText("Дополнительная станция · addon-station · версия 1")).toHaveLength(
      2,
    );
    expect(screen.getByText("3 из 2 · лимит превышен на 1")).toBeDefined();
    expect(screen.getByText("5 из 4 · лимит превышен на 1")).toBeDefined();
    expect(screen.getByText("Согласованный переход")).toBeDefined();
    expect(screen.getByText("platform_manual")).toBeDefined();
  });

  it("requires an explicit renewal confirmation and never renders delivery internals", async () => {
    const detail = {
      ...structuredClone(TENANT_DETAIL),
      subscriptionStatus: "pending_activation",
      ownerActivation: {
        ...structuredClone(TENANT_DETAIL.ownerActivation),
        emailVerified: false,
        status: "queued",
      },
      currentSubscription: {
        ...structuredClone(TENANT_DETAIL.currentSubscription),
        status: "pending_activation",
        startsAt: null,
        endsAt: null,
      },
    };
    const api = installTenantApi({ me: SUPPORT_ME, detail });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByText("Ожидает активации владельца")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Отправить активацию повторно" }));
    expect(api.mutationCalls()).toEqual([]);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("owner@example.com")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Подтвердить отправку" }));

    expect(await screen.findByText("Новая активация поставлена в очередь")).toBeDefined();
    expect(api.mutationCalls()).toHaveLength(1);
    expect(document.body.textContent).not.toContain("deliveryId");
    expect(document.body.textContent).not.toContain("http://");
  });

  it("requires a reason and confirms the exact immutable plan before one admin request", async () => {
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText("Тип операции"), "plan");
    await user.selectOptions(
      screen.getByLabelText("Версия тарифа"),
      "91111111-1111-4111-8111-111111111111",
    );
    await user.selectOptions(screen.getByLabelText("Начало действия"), "after_current");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    expect(await screen.findByText("Укажите причину изменения")).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);

    await user.type(screen.getByLabelText("Причина"), "Согласованный переход на производство");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Производственный · plan-production · версия 3")).toBeDefined();
    expect(within(dialog).getByText("После текущего тарифа")).toBeDefined();
    expect(within(dialog).getByText("Линии: 10")).toBeDefined();
    expect(within(dialog).getByText("Публичный API: включён")).toBeDefined();
    expect(
      within(dialog).getByText("Причина: Согласованный переход на производство"),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));

    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: `/api/platform/tenants/${TENANT_ID}/subscription/plan`,
        body: {
          catalogVersionId: "91111111-1111-4111-8111-111111111111",
          activationPolicy: "after_current",
          reason: "Согласованный переход на производство",
        },
      },
    ]);
  });

  it("confirms add-on quantity, resulting quota, and reason before submitting", async () => {
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText("Тип операции"), "addon");
    await user.selectOptions(screen.getByLabelText("Версия дополнения"), ADDON.id);
    await user.clear(screen.getByLabelText("Количество"));
    await user.type(screen.getByLabelText("Количество"), "2");
    await user.type(screen.getByLabelText("Причина"), "Две дополнительные станции");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Количество: 2")).toBeDefined();
    expect(within(dialog).getByText("Станции после изменения: 6")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));

    expect(api.mutationCalls()[0]).toEqual({
      method: "POST",
      path: `/api/platform/tenants/${TENANT_ID}/subscription/addons`,
      body: {
        catalogVersionId: ADDON.id,
        quantity: 2,
        activationPolicy: "immediate",
        reason: "Две дополнительные станции",
      },
    });
  });

  it("keeps support read-only and sends accountants to offers without a direct bypass", async () => {
    installTenantApi({ me: SUPPORT_ME });
    const support = renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.queryByLabelText("Тип операции")).toBeNull();
    expect(screen.queryByText(/₽|Цена|Оплат/)).toBeNull();
    support.unmount();

    installTenantApi({ me: ACCOUNTANT_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(
      (await screen.findByRole("link", { name: "Перейти к предложениям" })).getAttribute("href"),
    ).toBe(`/offers?tenantId=${TENANT_ID}`);
    expect(screen.queryByLabelText("Тип операции")).toBeNull();
  });

  it("does not silently discard an unfinished assignment during route navigation", async () => {
    installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    const reason = await screen.findByLabelText("Причина");
    await user.type(reason, "Неоконченная причина");
    await user.click(screen.getByRole("link", { name: "Каталог" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Есть несохранённые изменения")).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Продолжить редактирование" }));
    expect(screen.getByDisplayValue("Неоконченная причина")).toBeDefined();

    await user.click(screen.getByRole("link", { name: "Каталог" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Отменить изменения",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
  });

  it("rejects an invalid route UUID at the client boundary without a tenant request", async () => {
    installTenantApi();
    renderSaasApp({ initialEntry: "/tenants/not-a-uuid" });

    expect(await screen.findByText("Некорректный идентификатор тенанта")).toBeDefined();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("not-a-uuid")),
    ).toBe(false);
  });
});
