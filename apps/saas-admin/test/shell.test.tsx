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

  it("distinguishes loading, network, unauthenticated, and forbidden states", async () => {
    const loading = renderSaasApp({ state: authState({ sessionPending: true }) });
    expect(screen.getByRole("status").textContent).toContain("Проверяем платформенный сеанс");
    loading.unmount();

    const network = renderSaasApp({ state: authState({ sessionError: new Error("offline") }) });
    expect(screen.getByRole("alert").textContent).toContain("Не удалось проверить сеанс");
    network.unmount();

    renderSaasApp({ state: authState() });
    expect(await screen.findByRole("heading", { name: "Вход в платформу" })).toBeDefined();
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "Forbidden" })),
    );
    renderSaasApp({ state: authState({ session: readySession(true) }) });
    expect(await screen.findByRole("heading", { name: "Доступ ограничен" })).toBeDefined();
  });
});
