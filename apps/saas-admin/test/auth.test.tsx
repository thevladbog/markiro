import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("platform authentication", () => {
  it("uses the official Markiro identity in the platform-operations auth shell", async () => {
    renderSaasApp({ initialEntry: "/login", state: authState() });

    const logos = await screen.findAllByRole("img", { name: "Логотип Маркиро" });
    expect(logos.length).toBeGreaterThan(0);
    expect(logos.every((logo) => logo.querySelector("img"))).toBe(true);
    expect(
      screen.getByRole("complementary", { name: "Операционный контур Markiro" }),
    ).toBeDefined();
  });

  it("removes the backend activation fragment from browser history and exchanges it only once", async () => {
    const activationToken = "backend-produced-activation-token-2026";
    window.history.replaceState(null, "", `/activate#token=${activationToken}`);
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return jsonResponse(200, { twoFactorEnrollmentRequired: true });
      }),
    );
    const activation = renderSaasApp({ initialEntry: "/activate", state: authState() });

    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(window.location.pathname).toBe("/activate");
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(activationToken);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Новый пароль"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Повторите пароль"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Активировать доступ" }));

    expect(await screen.findByText("Доступ активирован")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Активировать доступ" })).toBeNull();
    expect(requests).toEqual([
      {
        url: "/api/platform/activation/complete",
        body: { token: activationToken, password: "correct horse battery staple" },
      },
    ]);

    activation.unmount();
    renderSaasApp({ initialEntry: "/activate", state: authState() });
    await user.type(await screen.findByLabelText("Новый пароль"), "second submission password");
    await user.type(screen.getByLabelText("Повторите пароль"), "second submission password");
    const retryButton = await screen.findByRole("button", { name: "Активировать доступ" });
    const retryForm = retryButton.closest("form");
    expect((retryButton as HTMLButtonElement).disabled).toBe(true);
    expect(retryForm).not.toBeNull();
    if (!retryForm) throw new Error("Activation form was not rendered");
    fireEvent.submit(retryForm);

    expect(
      await screen.findByText(
        "Активация недоступна. Запросите новую ссылку у администратора платформы.",
      ),
    ).toBeDefined();
    expect(window.location.hash).toBe("");
    expect(requests).toHaveLength(1);
  });

  it("does not accept a malformed activation success", async () => {
    window.history.replaceState(null, "", "/activate#token=backend-produced-activation-token-2026");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { twoFactorEnrollmentRequired: false })),
    );
    renderSaasApp({ initialEntry: "/activate", state: authState() });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Новый пароль"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Повторите пароль"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Активировать доступ" }));

    expect(
      await screen.findByText(
        "Активация недоступна. Запросите новую ссылку у администратора платформы.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Доступ активирован")).toBeNull();
  });

  it("does not open a protected page for a malformed platform principal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/api/platform/me")) {
          return jsonResponse(200, {
            userId: "platform-user-1",
            role: "support",
            capabilities: ["billing.write"],
            twoFactorReady: true,
          });
        }
        return jsonResponse(200, []);
      }),
    );
    renderSaasApp({ initialEntry: "/catalog", state: authState({ session: readySession(true) }) });

    expect(await screen.findByText("Не удалось загрузить актуальные полномочия.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Каталог" })).toBeNull();
  });

  it("routes a password sign-in that needs 2FA to the TOTP challenge", async () => {
    const state = authState({ signInResult: { data: { twoFactorRedirect: true }, error: null } });
    renderSaasApp({ initialEntry: "/login", state });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Электронная почта"), "operator@example.invalid");
    await user.type(screen.getByLabelText("Пароль"), "password-value");
    await user.click(screen.getByRole("button", { name: "Войти" }));

    expect(await screen.findByRole("heading", { name: "Двухфакторная проверка" })).toBeDefined();
    expect(window.sessionStorage.getItem("markiro.platform.2fa-challenge")).toBe("pending");
  });

  it("restores a pending Better Auth challenge after refresh and protected-route navigation", async () => {
    window.sessionStorage.setItem("markiro.platform.2fa-challenge", "pending");
    const firstRender = renderSaasApp({ initialEntry: "/catalog", state: authState() });

    expect(await screen.findByRole("heading", { name: "Двухфакторная проверка" })).toBeDefined();
    firstRender.unmount();

    renderSaasApp({ initialEntry: "/catalog", state: authState() });
    expect(await screen.findByRole("heading", { name: "Двухфакторная проверка" })).toBeDefined();

    await userEvent.click(screen.getByRole("link", { name: "Отменить проверку" }));
    expect(await screen.findByRole("heading", { name: "Вход в платформу" })).toBeDefined();
    expect(window.sessionStorage.getItem("markiro.platform.2fa-challenge")).toBeNull();
  });

  it("forces an authenticated user without 2FA into enrollment", async () => {
    renderSaasApp({
      initialEntry: "/catalog",
      state: authState({ session: readySession(false) }),
    });

    expect(await screen.findByRole("heading", { name: "Настройте 2FA" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Каталог" })).toBeNull();
  });

  it("renders a scannable QR code and keeps the manual TOTP key during enrollment", async () => {
    const state = authState({ session: readySession(false) });
    renderSaasApp({
      initialEntry: "/two-factor?mode=enroll",
      state,
      client: fakeAuthClient(state),
    });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Пароль"), "password-value");
    await user.click(screen.getByRole("button", { name: "Создать ключ 2FA" }));

    const qrCode = await screen.findByRole("img", {
      name: "QR-код для настройки двухфакторной аутентификации",
    });
    expect(qrCode.tagName).toBe("svg");
    expect(qrCode.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(screen.getByText(state.enrollment.totpURI)).toBeDefined();
  });

  it("accepts a TOTP challenge and opens the protected catalog", async () => {
    window.sessionStorage.setItem("markiro.platform.2fa-challenge", "pending");
    installCatalogApi();
    const state = authState();
    renderSaasApp({ initialEntry: "/two-factor?mode=challenge", state });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Код из приложения"), "123456");
    await user.click(screen.getByRole("button", { name: "Подтвердить код" }));

    expect(await screen.findByRole("heading", { name: "Каталог" })).toBeDefined();
    expect(window.sessionStorage.getItem("markiro.platform.2fa-challenge")).toBeNull();
  });

  it("clears an expired challenge marker and returns to login", async () => {
    window.sessionStorage.setItem("markiro.platform.2fa-challenge", "pending");
    const state = authState({
      verifyTotpResult: {
        data: null,
        error: { code: "INVALID_TWO_FACTOR_COOKIE", message: "Expired challenge" },
      },
    });
    renderSaasApp({ initialEntry: "/two-factor?mode=challenge", state });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Код из приложения"), "123456");
    await user.click(screen.getByRole("button", { name: "Подтвердить код" }));

    expect(await screen.findByRole("heading", { name: "Вход в платформу" })).toBeDefined();
    expect(window.sessionStorage.getItem("markiro.platform.2fa-challenge")).toBeNull();
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
