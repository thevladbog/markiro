import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_ADMIN_ME,
  TENANT_DETAIL,
  TENANT_ID,
  installCatalogApi,
  installTenantApi,
  jsonResponse,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function expectNoNativeSelects() {
  expect(document.querySelectorAll('select:not([aria-hidden="true"])')).toHaveLength(0);
}

async function chooseSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  const trigger = await screen.findByRole("combobox", { name: label });
  trigger.focus();
  await user.keyboard("[ArrowDown]");
  await user.click(await screen.findByRole("option", { name: option }));
  await waitFor(() => expect(trigger.textContent).toContain(option));
}

async function chooseSearchOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  query: string,
  option: RegExp,
) {
  const trigger = await screen.findByRole("combobox", { name: label });
  await user.click(trigger);
  await user.type(screen.getByRole("searchbox"), query);
  await user.keyboard("[ArrowDown][Enter]");
  expect(trigger.textContent).toMatch(option);
}

describe("SaaS-admin custom controls", () => {
  it("changes an existing team role through a keyboard-opened custom select", async () => {
    const mutationCalls: Array<{ path: string; body: unknown }> = [];
    let currentRole = "support";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
        if (url.endsWith("/api/platform/team") && method === "GET") {
          return jsonResponse(200, [
            {
              id: "team-user-1",
              name: "Support User",
              email: "support@example.invalid",
              role: currentRole,
              status: "active",
              twoFactorReady: true,
              createdAt: "2026-08-12T08:00:00.000Z",
            },
          ]);
        }
        if (url.endsWith("/api/platform/team/team-user-1/role") && method === "PATCH") {
          const body = JSON.parse(String(init.body));
          mutationCalls.push({ path: url, body });
          currentRole = body.role;
          return jsonResponse(200, {});
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    renderSaasApp({ initialEntry: "/team" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Команда платформы" })).toBeDefined();
    expectNoNativeSelects();
    await chooseSelectOption(user, "Роль для support@example.invalid", "Бухгалтер");

    await waitFor(() => {
      expect(mutationCalls).toEqual([
        {
          path: "/api/platform/team/team-user-1/role",
          body: { role: "accountant" },
        },
      ]);
    });
  });

  it("uses keyboard-visible custom selectors in the catalog editor", async () => {
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp({ initialEntry: "/catalog" });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    expectNoNativeSelects();
    await chooseSelectOption(user, "Единица учёта", "Год");
    await chooseSelectOption(user, "НДС", "Без НДС");
  });

  it("filters tenants through a keyboard-opened custom status selector", async () => {
    installTenantApi();
    renderSaasApp({ initialEntry: "/tenants" });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Тенанты" })).toBeDefined();
    expectNoNativeSelects();
    await chooseSelectOption(user, "Статус подписки", "Ожидает активации");

    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([input]) => String(input).includes("status=pending_activation")),
      ).toBe(true);
    });
  });

  it("searches catalog versions by keyboard and preserves exact assignment values", async () => {
    const detail = {
      ...structuredClone(TENANT_DETAIL),
      scheduledSubscription: null,
      scheduledAddons: [],
    };
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME, detail });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Первый завод" })).toBeDefined();
    expectNoNativeSelects();
    await chooseSearchOption(user, "Версия тарифа", "Производственный", /Производственный/);
    await user.type(screen.getByLabelText("Причина"), "Клавиатурное назначение");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Назначить точную версию" }));

    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: `/api/platform/tenants/${TENANT_ID}/subscription/plan`,
        body: {
          catalogVersionId: "91111111-1111-4111-8111-111111111111",
          activationPolicy: "immediate",
          reason: "Клавиатурное назначение",
        },
      },
    ]);
  });
});
