import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  ADDON,
  PLATFORM_ADMIN_ME,
  SUPPORT_ME,
  TENANT_DETAIL,
  TENANT_ID,
  authState,
  fakeAuthClient,
  installTenantApi,
  jsonResponse,
  readySession,
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

const PRODUCTION_PLAN = "Производственный · plan-production · версия 3";
const STATION_ADDON = "Дополнительная станция · addon-station · версия 1";

describe("tenant subscription detail", () => {
  it("keeps overview stable and opens non-blocking legal data in a dedicated tab", async () => {
    installTenantApi();
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(
      screen.getByRole("tab", { name: /Обзор и подписка/ }).getAttribute("aria-selected"),
    ).toBe("true");
    await user.click(screen.getByRole("tab", { name: /Юридические данные/ }));

    expect(await screen.findByText("Юридические данные тенанта")).toBeDefined();
    expect(
      screen.getByText(/не блокируют работу тенанта и производственные операции/i),
    ).toBeDefined();
    expect(screen.queryByText("Текущий и запланированный тарифы")).toBeNull();
  });

  it("accepts a production-like legacy tenant detail with PostgreSQL timestamps", async () => {
    const detail = {
      ...structuredClone(TENANT_DETAIL),
      tenant: {
        ...structuredClone(TENANT_DETAIL.tenant),
        id: "legacy_better_auth_org",
        createdAt: "2026-08-11 18:08:42.158",
      },
      currentSubscription: {
        ...structuredClone(TENANT_DETAIL.currentSubscription),
        tenantId: "legacy_better_auth_org",
        createdAt: "2026-08-11 18:08:42.158+00",
        updatedAt: "2026-08-11 18:08:42.158",
        startsAt: null,
        endsAt: null,
      },
    };
    installTenantApi({ detail });

    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.queryByText("Не удалось загрузить данные тенанта.")).toBeNull();
  });

  it("accepts subscriptions and add-ons created from a paid invoice line", async () => {
    const detail = structuredClone(TENANT_DETAIL);
    detail.currentSubscription.source = "paid_invoice_line";
    detail.activeAddons[0]!.source = "paid_invoice_line";
    installTenantApi({ detail });

    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.getAllByText("Оплаченный счёт")).toHaveLength(2);
  });

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
    const detail = {
      ...structuredClone(TENANT_DETAIL),
      scheduledSubscription: null,
      scheduledAddons: [],
    };
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME, detail });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await chooseOption(user, "Тип операции", "Тариф");
    await chooseOption(user, "Версия тарифа", PRODUCTION_PLAN);
    await chooseOption(user, "Начало действия", "После текущего тарифа");
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

    await chooseOption(user, "Тип операции", "Дополнение");
    await chooseOption(user, "Версия дополнения", STATION_ADDON);
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
        expectedSubscriptionId: "b1111111-1111-4111-8111-111111111111",
        quantity: 2,
        activationPolicy: "immediate",
        reason: "Две дополнительные станции",
      },
    });
  });

  it("pins an after-current add-on to the exact refreshed scheduled subscription", async () => {
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await chooseOption(user, "Тип операции", "Дополнение");
    await chooseOption(user, "Версия дополнения", STATION_ADDON);
    await chooseOption(user, "Начало действия", "После текущего тарифа");
    await user.clear(screen.getByLabelText("Количество"));
    await user.type(screen.getByLabelText("Количество"), "2");
    await user.type(screen.getByLabelText("Причина"), "Дополнение следующего тарифа");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Целевой тариф: Производственный · plan-production · версия 3"),
    ).toBeDefined();
    expect(
      within(dialog).getByText("Целевая подписка: d1111111-1111-4111-8111-111111111111"),
    ).toBeDefined();
    expect(within(dialog).getByText("Станции после изменения: 16")).toBeDefined();
    expect(api.detailRequestCount()).toBe(2);
    expect(api.mutationCalls()).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));
    expect(api.mutationCalls()[0]).toMatchObject({
      body: {
        catalogVersionId: ADDON.id,
        expectedSubscriptionId: "d1111111-1111-4111-8111-111111111111",
        activationPolicy: "after_current",
        quantity: 2,
      },
    });
  });

  it("refuses to promise after-current scheduling when the refreshed current term has ended", async () => {
    const initial = {
      ...structuredClone(TENANT_DETAIL),
      scheduledSubscription: null,
      scheduledAddons: [],
    };
    const expired = {
      ...structuredClone(TENANT_DETAIL),
      scheduledSubscription: null,
      scheduledAddons: [],
    };
    expired.currentSubscription.endsAt = new Date(Date.now() - 60_000).toISOString();
    const api = installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detailResponses: [initial, expired],
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await chooseOption(user, "Тип операции", "Тариф");
    await chooseOption(user, "Версия тарифа", PRODUCTION_PLAN);
    await chooseOption(user, "Начало действия", "После текущего тарифа");
    await user.type(screen.getByLabelText("Причина"), "Переход после завершения");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));

    expect(
      await screen.findAllByText(
        "Текущий тариф уже завершён. Обновите данные и выберите немедленное назначение.",
      ),
    ).toHaveLength(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Начало действия" }));
    expect(
      screen.getByRole("option", { name: "После текущего тарифа" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(api.mutationCalls()).toEqual([]);
  });

  it("does not offer another after-current plan when a successor already exists", async () => {
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    await screen.findByLabelText("Тип операции");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Начало действия" }));
    expect(
      screen.getByRole("option", { name: "После текущего тарифа" }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText(
        "Следующий тариф уже запланирован. Изменить его можно только немедленным назначением.",
      ),
    ).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);
  });

  it("enforces the ten-year term ceiling and repeats the normalized end date before mutation", async () => {
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await chooseOption(user, "Тип операции", "Тариф");
    await chooseOption(user, "Версия тарифа", PRODUCTION_PLAN);
    await user.type(screen.getByLabelText("Причина"), "Ограниченный срок");
    await user.type(screen.getByLabelText("Окончание действия"), "2037-01-01T12:00");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));

    expect(await screen.findByText("Срок назначения не может превышать 10 лет")).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);

    await user.clear(screen.getByLabelText("Окончание действия"));
    await user.type(screen.getByLabelText("Окончание действия"), "2027-01-01T12:00");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/^Окончание: 1 янв\. 2027 г\.,/)).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));
    const submittedEndsAt = (api.mutationCalls()[0]?.body as { endsAt?: unknown } | undefined)
      ?.endsAt;
    expect(typeof submittedEndsAt).toBe("string");
    const normalizedEndsAt = new Date(submittedEndsAt as string);
    expect(normalizedEndsAt.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(normalizedEndsAt.getUTCMinutes()).toBe(0);
  });

  it("keeps support read-only and presents offers as deliberately unavailable", async () => {
    installTenantApi({ me: SUPPORT_ME });
    const support = renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.queryByLabelText("Тип операции")).toBeNull();
    expect(screen.queryByText(/₽|Цена|Оплат/)).toBeNull();
    support.unmount();

    installTenantApi({ me: ACCOUNTANT_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(
      await screen.findByText(
        "Оформление предложения появится в разделе «Предложения» после его запуска.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: "Перейти к предложениям" })).toBeNull();
    expect(screen.queryByLabelText("Тип операции")).toBeNull();
  });

  it("disables renewal while activation delivery is sending and explains why", async () => {
    const detail = {
      ...structuredClone(TENANT_DETAIL),
      ownerActivation: {
        ...structuredClone(TENANT_DETAIL.ownerActivation),
        emailVerified: false,
        status: "sending",
      },
    };
    installTenantApi({ me: SUPPORT_ME, detail });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    const renew = await screen.findByRole("button", { name: "Отправить активацию повторно" });
    expect((renew as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Письмо уже отправляется. Повторная отправка будет доступна позже."),
    ).toBeDefined();
  });

  it("maps renew, plan, and add-on errors through explicit allowlists", async () => {
    const pendingDetail = {
      ...structuredClone(TENANT_DETAIL),
      ownerActivation: {
        ...structuredClone(TENANT_DETAIL.ownerActivation),
        emailVerified: false,
        status: "failed",
      },
    };
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: pendingDetail,
      renewResponses: [
        { status: 409, code: "tenants.status.active" },
        { status: 409, code: "activation_delivery_changed" },
      ],
      assignmentResponses: [
        { status: 409, code: "subscription_timeline_changed" },
        { status: 409, code: "subscription_addon_timeline_changed" },
      ],
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Отправить активацию повторно" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Подтвердить отправку",
      }),
    );
    expect(
      await within(screen.getByRole("alertdialog")).findByText("Не удалось обновить активацию"),
    ).toBeDefined();
    expect(screen.queryByText("Активна")).toBeNull();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Подтвердить отправку",
      }),
    );
    expect(
      await within(screen.getByRole("alertdialog")).findByText(
        "Состояние доставки изменилось. Обновите страницу и повторите.",
      ),
    ).toBeDefined();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Отмена" }),
    );

    await chooseOption(user, "Тип операции", "Тариф");
    await chooseOption(user, "Версия тарифа", PRODUCTION_PLAN);
    await user.type(screen.getByLabelText("Причина"), "Проверка конфликта тарифа");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Назначить точную версию",
      }),
    );
    expect(
      await within(screen.getByRole("alertdialog")).findByText(
        "Линия подписки изменилась. Обновите страницу и проверьте заново.",
      ),
    ).toBeDefined();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Отмена" }),
    );

    await chooseOption(user, "Тип операции", "Дополнение");
    await chooseOption(user, "Версия дополнения", STATION_ADDON);
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Назначить точную версию",
      }),
    );
    expect(
      await within(screen.getByRole("alertdialog")).findByText(
        "Линия дополнений изменилась. Обновите страницу и проверьте заново.",
      ),
    ).toBeDefined();
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

  it("does not destroy the session when dirty sign-out is cancelled", async () => {
    const state = authState({ session: readySession() });
    let signOutCalls = 0;
    const client = fakeAuthClient(state, { onSignOut: () => (signOutCalls += 1) });
    installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}`, state, client });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Причина"), "Не завершено");
    await user.click(screen.getByRole("button", { name: "Выйти" }));

    expect(signOutCalls).toBe(0);
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Продолжить редактирование" }));
    expect(signOutCalls).toBe(0);
    expect(screen.getByDisplayValue("Не завершено")).toBeDefined();
  });

  it("protects route, sign-out, and unload navigation while renewal is in flight", async () => {
    const pendingDetail = {
      ...structuredClone(TENANT_DETAIL),
      ownerActivation: {
        ...structuredClone(TENANT_DETAIL.ownerActivation),
        emailVerified: false,
        status: "failed",
      },
    };
    let resolveRenew: ((response: Response) => void) | undefined;
    const renewal = new Promise<Response>((resolve) => {
      resolveRenew = resolve;
    });
    const state = authState({ session: readySession() });
    let signOutCalls = 0;
    const client = fakeAuthClient(state, { onSignOut: () => (signOutCalls += 1) });
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: pendingDetail,
      renewHandler: () => renewal,
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}`, state, client });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Отправить активацию повторно" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Подтвердить отправку",
      }),
    );
    await waitFor(() =>
      expect(
        (
          within(screen.getByRole("alertdialog")).getByRole("button", {
            name: "Подтвердить отправку",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );

    const unload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(screen.getByRole("link", { name: "Каталог" }));
    expect(screen.getByRole("heading", { name: "Первый завод" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Выйти" }));
    expect(signOutCalls).toBe(0);
    expect(screen.getByText("Операция выполняется. Дождитесь её завершения.")).toBeDefined();

    resolveRenew?.(jsonResponse(200, { deliveryId: "14111111-1111-4111-8111-111111111111" }));
    expect(await screen.findByText("Новая активация поставлена в очередь")).toBeDefined();
  });

  it("uses an ordered heading outline below the tenant page title", async () => {
    installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    expect(await screen.findByRole("heading", { level: 1, name: "Первый завод" })).toBeDefined();
    for (const name of [
      "Обзор",
      "Текущий тариф",
      "Следующий тариф",
      "Использование и лимиты",
      "Активные дополнения",
      "Запланированные дополнения",
      "Прямое назначение",
      "История подписки",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeDefined();
    }
    const levels = screen
      .getAllByRole("heading")
      .map((heading) => Number(heading.tagName.slice(1)));
    expect(levels.every((level, index) => index === 0 || level - levels[index - 1]! <= 1)).toBe(
      true,
    );
  });

  it("rejects an overlong tenant reference at the client boundary without a tenant request", async () => {
    const overlongTenantReference = "t".repeat(129);
    installTenantApi();
    renderSaasApp({ initialEntry: `/tenants/${overlongTenantReference}` });

    expect(await screen.findByText("Некорректный идентификатор тенанта")).toBeDefined();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes(overlongTenantReference)),
    ).toBe(false);
  });
});
