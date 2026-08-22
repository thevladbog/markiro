import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authState,
  installCatalogApi,
  jsonResponse,
  readySession,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SaaS-admin shell", () => {
  const requestId = "31111111-1111-4111-8111-111111111111";

  it("uses one h1, semantic landmarks, and a slim operational status rail", async () => {
    installCatalogApi();
    renderSaasApp();

    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("banner")).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Разделы платформы" })).toBeDefined();
    expect(screen.getByRole("main")).toBeDefined();
    expect(screen.getByRole("status", { name: "Состояние платформы" }).textContent).toContain(
      "Сеанс · подтверждён",
    );
    expect(screen.getByText("SAAS CONSOLE · 01")).toBeDefined();
    const logo = screen.getByRole("img", { name: "Логотип Маркиро" });
    expect(logo.querySelector("img")).not.toBeNull();
  });

  it("does not claim API availability when catalog loading fails", async () => {
    installCatalogApi({ catalogStatus: 500 });
    renderSaasApp();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Не удалось загрузить каталог",
    );
    expect(screen.getByRole("heading", { level: 1, name: "Каталог" })).toBeDefined();
    const rail = screen.getByRole("status", { name: "Состояние платформы" });
    expect(rail.textContent).toContain("Сеанс · подтверждён");
    expect(rail.textContent).not.toContain("API · доступен");
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
            { message: "raw-server-diagnostic-must-not-render", zod: "must-not-render" },
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
