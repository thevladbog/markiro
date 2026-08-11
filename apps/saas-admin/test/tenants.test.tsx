import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  SUPPORT_ME,
  TENANT_LIST_ITEM,
  installTenantApi,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("platform tenants", () => {
  it("renders distinct loading, empty, and error list states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/platform/me")) {
          return jsonResponse(200, SUPPORT_ME);
        }
        if (url.includes("/api/platform/tenants?")) {
          return await new Promise<Response>(() => undefined);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const loading = renderSaasApp({ initialEntry: "/tenants" });
    expect(await screen.findByText("Загружаем тенантов")).toBeDefined();
    loading.unmount();

    installTenantApi({ me: SUPPORT_ME, items: [] });
    const empty = renderSaasApp({ initialEntry: "/tenants" });
    expect(await screen.findByText("Тенантов пока нет")).toBeDefined();
    empty.unmount();

    installTenantApi({ me: SUPPORT_ME, listStatus: 503 });
    renderSaasApp({ initialEntry: "/tenants" });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Не удалось загрузить тенантов",
    );
  });

  it("truthfully searches only the bounded page and exposes all lifecycle filters", async () => {
    const second = {
      ...structuredClone(TENANT_LIST_ITEM),
      id: "16111111-1111-4111-8111-111111111111",
      name: "Северная площадка",
      slug: "north-site",
      subscriptionStatus: "pending_activation",
    };
    installTenantApi({ me: SUPPORT_ME, items: [TENANT_LIST_ITEM, second], total: 101 });
    renderSaasApp({ initialEntry: "/tenants" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Тенанты" })).toBeDefined();
    expect(screen.queryByText(/₽|Цена/)).toBeNull();
    expect(
      screen.getByText("Поиск выполняется только по текущей странице (до 50 тенантов)."),
    ).toBeDefined();
    expect(await screen.findByText("На странице: 2 из 2 · Всего: 101")).toBeDefined();
    const statusFilter = screen.getByLabelText("Статус подписки");
    expect(within(statusFilter).getByRole("option", { name: "Заменена" })).toBeDefined();
    expect(within(statusFilter).getByRole("option", { name: "Отменена" })).toBeDefined();
    expect(screen.getByText("Страница 1 из 3")).toBeDefined();

    await user.type(screen.getByLabelText("Поиск"), "северная");
    expect(screen.getByText("Северная площадка")).toBeDefined();
    expect(screen.queryByText("Первый завод")).toBeNull();
    expect(screen.getByText("На странице: 1 из 2 · Всего: 101")).toBeDefined();
    await user.clear(screen.getByLabelText("Поиск"));
    await user.type(screen.getByLabelText("Поиск"), "нет на странице");
    expect(screen.getByText("На текущей странице совпадений нет")).toBeDefined();
    expect(screen.getByText("На странице: 0 из 2 · Всего: 101")).toBeDefined();
    expect(screen.getByText("Страница 1 из 3")).toBeDefined();

    await user.selectOptions(statusFilter, "pending_activation");

    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes("status=pending_activation")),
    ).toBe(true);
  });

  it("keeps onboarding only for a globally empty list and explains a filtered zero result", async () => {
    installTenantApi({ me: SUPPORT_ME, items: [], total: 0 });
    renderSaasApp({ initialEntry: "/tenants" });
    const user = userEvent.setup();

    expect(await screen.findByText("Тенантов пока нет")).toBeDefined();
    expect(
      screen.getByText("Создайте первый тенант и отправьте владельцу письмо активации."),
    ).toBeDefined();

    await user.selectOptions(screen.getByLabelText("Статус подписки"), "active");

    expect(await screen.findByText("Нет тенантов с выбранным статусом")).toBeDefined();
    expect(screen.getByText("Выберите другой статус, чтобы продолжить поиск")).toBeDefined();
    expect(screen.queryByText("Тенантов пока нет")).toBeNull();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("status=active")),
    ).toBe(true);
  });

  it("gives the horizontally scrollable tenant table a keyboard focus target and name", async () => {
    installTenantApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: "/tenants" });

    const tableRegion = await screen.findByRole("region", {
      name: "Тенанты на текущей странице",
    });
    expect(tableRegion.getAttribute("tabindex")).toBe("0");
  });

  it("shows financial terms to an accountant without exposing tenant creation", async () => {
    installTenantApi({ me: ACCOUNTANT_ME });
    renderSaasApp({ initialEntry: "/tenants" });

    expect(await screen.findByText("15 000,00 ₽")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Создать тенанта" })).toBeNull();
  });

  it("blocks invalid create input, then sends only name, slug, and owner email", async () => {
    const api = installTenantApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: "/tenants/new" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Новый тенант" })).toBeDefined();
    expect(screen.queryByLabelText(/парол/i)).toBeNull();
    await user.type(screen.getByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "Invalid Slug");
    await user.type(screen.getByLabelText("Email владельца"), "wrong-email");
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
    expect(
      await screen.findByText("Только строчные латинские буквы, цифры и дефисы"),
    ).toBeDefined();
    expect(screen.getByText("Введите корректный адрес")).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);

    await user.clear(screen.getByLabelText("Slug"));
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.clear(screen.getByLabelText("Email владельца"));
    await user.type(screen.getByLabelText("Email владельца"), "OWNER@example.com");
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: "/api/platform/tenants",
        body: {
          tenantName: "Первый завод",
          tenantSlug: "first-factory",
          email: "owner@example.com",
        },
      },
    ]);
    expect(document.body.textContent).not.toContain("deliveryId");
  });

  it("keeps create values and localizes duplicate owner, duplicate slug, and missing-demo errors", async () => {
    installTenantApi({
      me: SUPPORT_ME,
      createResponses: [
        { status: 409, code: "tenant_owner_email_conflict" },
        { status: 409, code: "tenant_first_owner_conflict" },
        { status: 409, code: "default_demo_not_configured" },
      ],
    });
    renderSaasApp({ initialEntry: "/tenants/new" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "RU" }));
    await user.type(await screen.findByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.type(screen.getByLabelText("Email владельца"), "owner@example.com");

    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
    expect(await screen.findByText("Этот email уже связан с другим владельцем")).toBeDefined();
    expect(screen.getByDisplayValue("Первый завод")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
    expect(await screen.findByText("Slug уже занят другим владельцем")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
    expect(
      await screen.findByText("Сначала назначьте опубликованный демо-тариф по умолчанию"),
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "EN" }));
    expect(
      within(screen.getByRole("alert")).getByText(
        "Select a published default demo plan before creating a tenant",
      ),
    ).toBeDefined();
  });

  it("uses an allowlisted generic create error for an unknown server code", async () => {
    installTenantApi({
      me: SUPPORT_ME,
      createResponses: [{ status: 409, code: "tenants.status.active" }],
    });
    renderSaasApp({ initialEntry: "/tenants/new" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "RU" }));
    await user.type(await screen.findByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.type(screen.getByLabelText("Email владельца"), "owner@example.com");

    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));

    expect(await screen.findByText("Не удалось создать тенанта")).toBeDefined();
    expect(screen.queryByText("Активна")).toBeNull();
  });
});
