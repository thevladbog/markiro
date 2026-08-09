import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authState,
  fakeAuthClient,
  installCatalogApi,
  jsonResponse,
  readySession,
  renderSaasApp,
} from "./render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("platform authentication", () => {
  it("removes the activation token from history and exchanges it only once", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return jsonResponse(200, { twoFactorEnrollmentRequired: true });
      }),
    );
    renderSaasApp({ initialEntry: "/activate?token=one-time-token", state: authState() });

    await waitFor(() => expect(window.location.search).not.toContain("token"));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Новый пароль"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Повторите пароль"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Активировать доступ" }));

    expect(await screen.findByText("Доступ активирован")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Активировать доступ" })).toBeNull();
    expect(requests).toEqual([
      {
        url: "/api/platform/activation/complete",
        body: { token: "one-time-token", password: "correct horse battery staple" },
      },
    ]);
  });

  it("routes a password sign-in that needs 2FA to the TOTP challenge", async () => {
    const state = authState({ signInResult: { data: { twoFactorRedirect: true }, error: null } });
    renderSaasApp({ initialEntry: "/login", state });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Электронная почта"), "operator@example.invalid");
    await user.type(screen.getByLabelText("Пароль"), "password-value");
    await user.click(screen.getByRole("button", { name: "Войти" }));

    expect(await screen.findByRole("heading", { name: "Двухфакторная проверка" })).toBeDefined();
  });

  it("forces an authenticated user without 2FA into enrollment", async () => {
    renderSaasApp({
      initialEntry: "/catalog",
      state: authState({ session: readySession(false) }),
    });

    expect(await screen.findByRole("heading", { name: "Настройте 2FA" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Каталог" })).toBeNull();
  });

  it("accepts a TOTP challenge and opens the protected catalog", async () => {
    installCatalogApi();
    const state = authState();
    renderSaasApp({ initialEntry: "/two-factor?mode=challenge", state });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Код из приложения"), "123456");
    await user.click(screen.getByRole("button", { name: "Подтвердить код" }));

    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
  });

  it("uses a backup code to invalidate old sessions and requires fresh enrollment", async () => {
    const state = authState();
    renderSaasApp({ initialEntry: "/recovery", state, client: fakeAuthClient(state) });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Резервный код"), "alpha-one");
    await user.type(screen.getByLabelText("Пароль"), "password-value");
    await user.click(screen.getByRole("button", { name: "Восстановить доступ" }));

    expect(await screen.findByRole("heading", { name: "Настройте 2FA" })).toBeDefined();
    expect(screen.getByText("Прежние сеансы завершены. Настройте новый ключ 2FA.")).toBeDefined();
  });
});
