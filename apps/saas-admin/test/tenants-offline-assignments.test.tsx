import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_ADMIN_ME,
  PUBLISHED_PLAN,
  SUPPORT_ME,
  TENANT_DETAIL,
  TENANT_ID,
  installTenantApi,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
const FLAGGED = {
  ...PUBLISHED_PLAN,
  id: "92111111-1111-4111-8111-111111111111",
  nameRu: "Автоном",
  catalogItemCode: "plan-standalone",
  version: 1,
  offlineAvailable: true,
};
const CLOUD_ONLY = {
  ...PUBLISHED_PLAN,
  id: "93111111-1111-4111-8111-111111111111",
  nameRu: "Облачный",
  catalogItemCode: "plan-cloud",
  version: 1,
  offlineAvailable: false,
};

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("direct assignment for a tenant without a cabinet", () => {
  it("shows the form with only the offline-flagged versions, an explanation and no entitlement usage", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [FLAGGED, CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Прямое назначение" })).toBeDefined();
    expect(await screen.findByText(/Клиент без кабинета: можно назначить только/)).toBeDefined();
    await user.click(await screen.findByRole("combobox", { name: "Версия тарифа" }));
    expect(
      await screen.findByRole("option", { name: "Автоном · plan-standalone · версия 1" }),
    ).toBeDefined();
    expect(screen.queryByRole("option", { name: /Облачный/ })).toBeNull();
    expect(screen.queryByText("Использование и лимиты")).toBeNull();
  });

  it("says so, with a link to the catalog, when no version is flagged", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByText(/Нет позиций, помеченных офлайн/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Открыть каталог" }).getAttribute("href")).toBe(
      "/catalog",
    );
    expect(screen.queryByRole("button", { name: "Проверить назначение" })).toBeNull();
  });

  it("posts the assignment of a flagged version with the entered reason", async () => {
    const api = installTenantApi({
      me: PLATFORM_ADMIN_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [FLAGGED, CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await chooseOption(user, "Версия тарифа", "Автоном · plan-standalone · версия 1");
    await user.type(screen.getByLabelText("Причина"), "Поставка автонома");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));

    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: `/api/platform/tenants/${TENANT_ID}/subscription/plan`,
        body: {
          catalogVersionId: FLAGGED.id,
          activationPolicy: "immediate",
          reason: "Поставка автонома",
        },
      },
    ]);
  });

  it("does not offer direct assignment to support", async () => {
    installTenantApi({
      me: SUPPORT_ME,
      detail: OFFLINE_DETAIL,
      catalogResponse: { items: [FLAGGED] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Прямое назначение" })).toBeNull();
  });

  it("keeps the cloud tenant's form unfiltered", async () => {
    installTenantApi({
      me: PLATFORM_ADMIN_ME,
      catalogResponse: { items: [FLAGGED, CLOUD_ONLY] },
    });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Версия тарифа" }));
    expect(await screen.findByRole("option", { name: /Облачный/ })).toBeDefined();
    expect(screen.getByRole("option", { name: /Автоном/ })).toBeDefined();
    expect(screen.queryByText(/Клиент без кабинета: можно назначить только/)).toBeNull();
  });
});
