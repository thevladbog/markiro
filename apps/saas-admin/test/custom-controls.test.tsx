import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_ADMIN_ME,
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

const TEAM_MEMBER = {
  id: "team-user-1",
  name: "Platform administrator",
  email: "admin@example.com",
  role: "platform_admin",
  status: "active",
  twoFactorReady: true,
  createdAt: "2026-08-12T08:00:00.000Z",
} as const;

function visibleNativeSelects() {
  return Array.from(document.querySelectorAll("select")).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

function installTeamApi({ status = TEAM_MEMBER.status }: { status?: "active" | "invited" } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let member: { status: "active" | "invited" } & Omit<typeof TEAM_MEMBER, "status"> = {
    ...TEAM_MEMBER,
    status,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      if (url.endsWith("/api/platform/team") && method === "GET") {
        return jsonResponse(200, [member]);
      }
      if (url.endsWith(`/api/platform/team/${TEAM_MEMBER.id}/role`) && method === "PATCH") {
        const body = JSON.parse(String(init.body));
        calls.push({ method, path: url, body });
        member = { ...member, role: body.role };
        return jsonResponse(200, { status: true });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return { calls: () => structuredClone(calls) };
}

describe("SaaS admin custom controls", () => {
  it("renders the invited status returned for a newly created platform user", async () => {
    installTeamApi({ status: "invited" });

    renderSaasApp({ initialEntry: "/team" });

    expect(await screen.findByText("Ожидает активации")).toBeDefined();
    expect(screen.queryByText("team.statuses.invited")).toBeNull();
  });

  it("replaces team native roles with keyboard-selectable controls and preserves the role mutation", async () => {
    const api = installTeamApi();
    renderSaasApp({ initialEntry: "/team" });
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Команда платформы" });
    expect(screen.getByText("Доступ операторов к управлению SaaS-платформой.")).toBeDefined();
    expect(await screen.findByRole("region", { name: "Операторы платформы" })).toBeDefined();
    expect(visibleNativeSelects()).toEqual([]);

    const role = screen.getByRole("combobox", { name: "Роль для admin@example.com" });
    expect(role.tagName).toBe("BUTTON");
    await user.click(role);
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(role.textContent).toContain("Поддержка"));
    expect(api.calls()).toEqual([
      {
        method: "PATCH",
        path: `/api/platform/team/${TEAM_MEMBER.id}/role`,
        body: { role: "support" },
      },
    ]);
  });

  it("renders catalog editing controls without native selects and changes their visible values", async () => {
    installCatalogApi({ me: PLATFORM_ADMIN_ME, items: [] });
    renderSaasApp({ initialEntry: "/catalog" });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Создать позицию" }));
    expect(visibleNativeSelects()).toEqual([]);

    const unit = screen.getByRole("combobox", { name: "Единица учёта" });
    expect(unit.tagName).toBe("BUTTON");
    await user.click(unit);
    await user.keyboard("{End}{Enter}");
    expect(unit.textContent).toContain("Другое");
  });

  it("renders tenant status filtering without a native select", async () => {
    installTenantApi();
    renderSaasApp({ initialEntry: "/tenants" });

    await screen.findByRole("heading", { name: "Тенанты" });
    expect(visibleNativeSelects()).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Статус подписки" }).tagName).toBe("BUTTON");
  });

  it("uses button controls for subscription assignment and submits the exact selected plan", async () => {
    const api = installTenantApi({ me: PLATFORM_ADMIN_ME });
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
    const user = userEvent.setup();

    await screen.findByLabelText("Тип операции");
    expect(visibleNativeSelects()).toEqual([]);

    const version = screen.getByRole("combobox", { name: "Версия тарифа" });
    expect(version.tagName).toBe("BUTTON");
    await user.click(version);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(version.textContent).toContain("Производственный · plan-production · версия 3");
    await user.type(screen.getByLabelText("Причина"), "Точное назначение");
    await user.click(screen.getByRole("button", { name: "Проверить назначение" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Назначить точную версию",
      }),
    );

    expect(api.mutationCalls()).toEqual([
      {
        method: "POST",
        path: `/api/platform/tenants/${TENANT_ID}/subscription/plan`,
        body: {
          catalogVersionId: "91111111-1111-4111-8111-111111111111",
          activationPolicy: "immediate",
          reason: "Точное назначение",
        },
      },
    ]);
  });
});
