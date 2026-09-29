import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNTANT_ME,
  PLATFORM_ADMIN_ME,
  SUPPORT_ME,
  TENANT_DETAIL,
  TENANT_ID,
  TENANT_LIST_ITEM,
  installTenantApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function rowOf(element: HTMLElement): HTMLElement {
  const row = element.closest("tr");
  if (!row) throw new Error("table row not found");
  return row;
}

const OFFLINE_DETAIL = {
  ...structuredClone(TENANT_DETAIL),
  tenant: { ...structuredClone(TENANT_DETAIL.tenant), cabinetAccess: "none" },
  subscriptionStatus: "unmanaged",
  ownerActivation: null,
  currentSubscription: null,
  scheduledSubscription: null,
  activeAddons: [],
  scheduledAddons: [],
  events: [],
};

const ENABLED_AFTER_GRANT = {
  ...structuredClone(OFFLINE_DETAIL),
  tenant: { ...structuredClone(TENANT_DETAIL.tenant), cabinetAccess: "enabled" },
  subscriptionStatus: "pending_activation",
  ownerActivation: {
    ...structuredClone(TENANT_DETAIL.ownerActivation),
    emailVerified: false,
    status: "queued",
  },
};

describe("tenant cabinet access", () => {
  it("keeps cabinet access on by default and requires the owner email", async () => {
    const api = installTenantApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: "/tenants/new" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Новый тенант" })).toBeDefined();
    const toggle = screen.getByRole("checkbox", { name: "Доступ в кабинет" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Email владельца")).toBeDefined();
    expect(screen.getByText(/Демо начнётся только после активации владельца/)).toBeDefined();

    await user.type(screen.getByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));

    expect(await screen.findByText("Введите корректный адрес")).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);
  });

  it("creates a tenant without a cabinet and posts no email key", async () => {
    const api = installTenantApi({ me: SUPPORT_ME, detail: OFFLINE_DETAIL });
    renderSaasApp({ initialEntry: "/tenants/new" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Новый тенант" })).toBeDefined();
    await user.type(screen.getByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    await user.type(screen.getByLabelText("Email владельца"), "draft@example.com");
    await user.click(screen.getByRole("checkbox", { name: "Доступ в кабинет" }));

    expect(screen.queryByLabelText("Email владельца")).toBeNull();
    expect(screen.queryByText(/Демо начнётся только после активации владельца/)).toBeNull();
    expect(
      screen.getByText(/Тенант без кабинета: владелец, письмо активации и демо не создаются/),
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Создать тенант без кабинета" }));

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    const calls = api.mutationCalls();
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/platform/tenants",
        body: { tenantName: "Первый завод", tenantSlug: "first-factory", cabinetAccess: "none" },
      },
    ]);
    expect(JSON.stringify(calls[0]?.body)).not.toContain("email");
    expect(screen.getByText("Тенант создан без кабинета.")).toBeDefined();
    expect(screen.queryByText(/Ожидает активации владельца/)).toBeNull();
  });

  it("restores the required email when cabinet access is switched back on", async () => {
    const api = installTenantApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: "/tenants/new" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Новый тенант" })).toBeDefined();
    await user.type(screen.getByLabelText("Название"), "Первый завод");
    await user.type(screen.getByLabelText("Slug"), "first-factory");
    const toggle = screen.getByRole("checkbox", { name: "Доступ в кабинет" });
    await user.click(toggle);
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
    expect(await screen.findByText("Введите корректный адрес")).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);

    await user.type(screen.getByLabelText("Email владельца"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Создать и отправить активацию" }));
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(api.mutationCalls()[0]?.body).toEqual({
      tenantName: "Первый завод",
      tenantSlug: "first-factory",
      email: "owner@example.com",
      cabinetAccess: "enabled",
    });
  });

  it("shows a tenant without a cabinet instead of the owner block and subscription", async () => {
    installTenantApi({ me: PLATFORM_ADMIN_ME, detail: OFFLINE_DETAIL });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    const panel = screen.getByRole("region", { name: "Кабинет не выдан" });
    expect(within(panel).getByRole("button", { name: "Выдать доступ в кабинет" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Активация владельца" })).toBeNull();
    expect(screen.queryByText("Текущий и запланированный тарифы")).toBeNull();
    expect(
      screen.getByText(/Платформа не отправляет этому тенанту документы и уведомления/),
    ).toBeDefined();
  });

  it("lets support grant cabinet access but not the accountant", async () => {
    installTenantApi({ me: SUPPORT_ME, detail: OFFLINE_DETAIL });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Выдать доступ в кабинет" })).toBeDefined();
    cleanup();
    vi.unstubAllGlobals();

    installTenantApi({ me: ACCOUNTANT_ME, detail: OFFLINE_DETAIL });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Кабинет не выдан" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Выдать доступ в кабинет" })).toBeNull();
  });

  it("grants cabinet access with the owner email and reloads the tenant", async () => {
    const api = installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      detailResponses: [OFFLINE_DETAIL, ENABLED_AFTER_GRANT],
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Выдать доступ в кабинет" }));
    await user.click(screen.getByRole("button", { name: "Выдать и отправить активацию" }));
    expect(await screen.findByText("Введите корректный адрес")).toBeDefined();
    expect(api.mutationCalls()).toEqual([]);

    await user.type(screen.getByLabelText("Email владельца"), "OWNER@example.com");
    await user.click(screen.getByRole("button", { name: "Выдать и отправить активацию" }));

    expect(
      await screen.findByText("Доступ выдан, письмо активации поставлено в очередь."),
    ).toBeDefined();
    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: `/api/platform/tenants/${TENANT_ID}/cabinet-access`,
        body: { email: "owner@example.com" },
      },
    ]);
    await waitFor(() => expect(api.detailRequestCount()).toBe(2));
    expect(await screen.findByRole("heading", { name: "Активация владельца" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Кабинет не выдан" })).toBeNull();
  });

  it("returns focus to the grant button when the form is cancelled", async () => {
    installTenantApi({ me: PLATFORM_ADMIN_ME, detail: OFFLINE_DETAIL });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Выдать доступ в кабинет" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Email владельца"));
    await user.click(screen.getByRole("button", { name: "Отмена" }));

    expect(screen.queryByLabelText("Email владельца")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Выдать доступ в кабинет" }),
      ),
    );
  });

  it("maps a grant conflict to an allowlisted message", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      grantResponses: [{ status: 409, code: "cabinet_access_already_enabled" }],
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Выдать доступ в кабинет" }));
    await user.type(screen.getByLabelText("Email владельца"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Выдать и отправить активацию" }));

    expect(await screen.findByText("У тенанта уже есть доступ в кабинет")).toBeDefined();
  });

  it("explains the demo created on grant and maps a missing default demo", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      grantResponses: [{ status: 409, code: "default_demo_not_configured" }],
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    const panel = screen.getByRole("region", { name: "Кабинет не выдан" });
    expect(
      within(panel).getByText(/вместе с доступом создаётся демо-подписка по умолчанию/),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Выдать доступ в кабинет" }));
    await user.type(screen.getByLabelText("Email владельца"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Выдать и отправить активацию" }));

    expect(
      await screen.findByText("Сначала назначьте опубликованный демо-тариф по умолчанию"),
    ).toBeDefined();
  });

  it("marks a tenant without a cabinet in the list with a text badge", async () => {
    installTenantApi({
      me: SUPPORT_ME,
      items: [
        TENANT_LIST_ITEM,
        {
          id: "16111111-1111-4111-8111-111111111111",
          name: "Офлайн-площадка",
          slug: "offline-site",
          createdAt: "2026-09-29T08:00:00.000Z",
          cabinetAccess: "none",
          subscriptionStatus: "unmanaged",
        },
      ],
    });
    renderSaasApp({ initialEntry: "/tenants" });

    const offlineRow = rowOf(await screen.findByText("Офлайн-площадка"));
    expect(within(offlineRow).getByText("Без кабинета")).toBeDefined();
    const enabledRow = rowOf(screen.getByText("Первый завод"));
    expect(within(enabledRow).queryByText("Без кабинета")).toBeNull();
  });
});
