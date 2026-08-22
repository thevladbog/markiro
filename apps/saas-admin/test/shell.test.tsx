import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authState, jsonResponse, readySession, renderSaasApp, SUPPORT_ME } from "./render.js";
import { installOperationsApi } from "./operationsFixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SaaS-admin operational shell", () => {
  const requestId = "31111111-1111-4111-8111-111111111111";

  it("opens on the operational overview with a grouped left rail and real identity", async () => {
    installOperationsApi();
    renderSaasApp({ initialEntry: "/" });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Операционный обзор" }),
    ).toBeDefined();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelector(".app-header")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Разделы платформы" })).toBeDefined();
    expect(screen.getByRole("main")).toBeDefined();
    expect(screen.getByText("Операции")).toBeDefined();
    expect(screen.getByText("Коммерция")).toBeDefined();
    expect(screen.getByText("Платформа")).toBeDefined();
    expect(screen.getByText("Настройки")).toBeDefined();
    expect(screen.getByRole("link", { name: "Обзор" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Счета" }).getAttribute("href")).toBe("/invoices");
    expect(screen.getByRole("link", { name: "Мониторинг" }).getAttribute("href")).toBe(
      "/monitoring",
    );
    expect(screen.getByRole("link", { name: "Наша организация" }).getAttribute("href")).toBe(
      "/settings/organization",
    );
    expect(
      screen.getByRole("img", { name: "Логотип Маркиро" }).querySelector("img"),
    ).not.toBeNull();
    expect(screen.queryByText("SAAS CONSOLE · 01")).toBeNull();
  });

  it("shows only capability-backed rail entries", async () => {
    installOperationsApi({ me: SUPPORT_ME });
    renderSaasApp({ initialEntry: "/" });

    expect(await screen.findByRole("heading", { name: "Операционный обзор" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Мониторинг" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Каталог" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Предложения" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Счета" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Платежи" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Наша организация" })).toBeNull();
  });

  it("moves focus into the mobile rail and restores it on Escape", async () => {
    const user = userEvent.setup();
    installOperationsApi();
    renderSaasApp({ initialEntry: "/" });

    const menu = await screen.findByRole("button", { name: /Меню/ });
    await user.click(menu);

    expect(document.querySelector(".app-workspace")?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Обзор" }));
    screen.getByRole("link", { name: "Наша организация" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Обзор" }));

    await user.click(screen.getByRole("link", { name: "Тенанты" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Тенанты" })).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(menu));
    expect(document.querySelector(".app-workspace")?.hasAttribute("inert")).toBe(false);

    await user.click(menu);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it("distinguishes loading, network, and unauthenticated states", async () => {
    const loading = renderSaasApp({ state: authState({ sessionPending: true }) });
    expect(screen.getByRole("status").textContent).toContain("Проверяем платформенный сеанс");
    loading.unmount();

    const network = renderSaasApp({ state: authState({ sessionError: new Error("offline") }) });
    expect(screen.getByRole("alert").textContent).toContain("Не удалось проверить сеанс");
    network.unmount();

    renderSaasApp({ state: authState() });
    expect(await screen.findByRole("heading", { name: "Вход в платформу" })).toBeDefined();
  });

  it.each([
    [401, "Вход в платформу"],
    [403, "Доступ ограничен"],
  ])(
    "uses authorization semantics only for a valid %s platform envelope",
    async (status, title) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(status, {
            code: status === 401 ? "platform_unauthorized" : "platform_forbidden",
          }),
        ),
      );
      renderSaasApp({ state: authState({ session: readySession(true) }) });
      expect(await screen.findByRole("heading", { name: title })).toBeDefined();
      expect(screen.queryByText("Формат ответа платформы изменился")).toBeNull();
    },
  );

  it.each([401, 403])(
    "keeps a malformed %s platform envelope on the safe contract retry path",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            status,
            {
              message: "raw-server-diagnostic-must-not-render",
              zod: "must-not-render",
            },
            { "x-request-id": requestId },
          ),
        ),
      );
      renderSaasApp({ state: authState({ session: readySession(true) }) });
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Формат ответа платформы изменился");
      expect(alert.textContent).toContain(requestId);
      expect(alert.textContent).not.toMatch(/raw-server-diagnostic|zod|must-not-render/i);
      expect(screen.getByRole("button", { name: "Повторить" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Доступ ограничен" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Вход в платформу" })).toBeNull();
    },
  );
});
