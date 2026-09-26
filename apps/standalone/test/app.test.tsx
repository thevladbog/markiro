import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { App } from "../src/app/App.js";
import type { HostApi } from "../src/host/api.js";
import { HostError } from "../src/host/client.js";
import { DeviceError, type DeviceApi } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type { DeviceStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, observation, SESSION } from "./support/fixtures.js";
import { fakeHostApi } from "./support/office.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

const ADDRESS = "https://127.0.0.1:45710";

/** Answers `hello` in order; the last answer repeats. `true`/`false` is `initialized`. */
function probeAnswering(...answers: Array<boolean | HostProbeError>) {
  let calls = 0;
  const hello = vi.fn<HostProbe["hello"]>(async () => {
    const answer = answers[Math.min(calls, answers.length - 1)] ?? true;
    calls += 1;
    if (answer instanceof HostProbeError) throw answer;
    return observation(answer);
  });
  return { hello };
}

/**
 * `pairLocally` rejects with `already_paired` once paired, like the real
 * shell. `pairResult` is what a fresh `pairLocally` call returns; it defaults
 * to `DEVICE_STATUS` and only needs overriding when a test pairs against a
 * host whose identity differs from that fixture (e.g. a reinstalled host).
 */
function fakeDevice(
  initial: DeviceStatus | null | DeviceError,
  pairResult: DeviceStatus = DEVICE_STATUS,
) {
  let paired: DeviceStatus | null = initial instanceof DeviceError ? null : initial;
  let broken = initial instanceof DeviceError ? initial : null;
  return {
    status: vi.fn<DeviceApi["status"]>(async () => {
      if (broken) throw broken;
      return paired;
    }),
    pairLocally: vi.fn<DeviceApi["pairLocally"]>(async () => {
      if (paired) throw new DeviceError("already_paired", "already paired");
      paired = pairResult;
      return pairResult;
    }),
    forget: vi.fn<DeviceApi["forget"]>(async () => {
      paired = null;
      broken = null;
    }),
  };
}

function fakeHost() {
  return fakeHostApi({
    bootstrap: vi.fn<HostApi["bootstrap"]>(async () => ({ session: SESSION })),
    officeLogin: vi.fn<HostApi["officeLogin"]>(async () => SESSION),
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(async () => undefined),
  });
}

function renderApp(services: { probe: HostProbe; device: DeviceApi; host: HostApi }) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <App {...services} address={ADDRESS} />
    </ThemeProvider>,
  );
}

async function signIn(): Promise<void> {
  await screen.findByText("Вход в офис");
  fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Войти" }));
}

/** The first call order of a mock, asserted to exist rather than cast away. */
function firstCallOrder(mockFn: { mock: { invocationCallOrder: number[] } }): number {
  const [order] = mockFn.mock.invocationCallOrder;
  if (order === undefined) throw new Error("expected the mock to have been called");
  return order;
}

describe("App", () => {
  it("creates the site on a fresh host and opens the office", async () => {
    const device = fakeDevice(null);
    const host = fakeHost();
    renderApp({ probe: probeAnswering(false), device, host });
    expect(await screen.findByText("Первый запуск")).toBeTruthy();
    await completeWizard();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(device.pairLocally).toHaveBeenCalledWith("Рабочее место хоста");
    expect(host.bootstrap).toHaveBeenCalledWith(EXPECTED_REQUEST);
    // The site must not be created on this computer before it is paired.
    expect(firstCallOrder(device.pairLocally)).toBeLessThan(firstCallOrder(host.bootstrap));
  });

  it("finishes the wizard without pairing again when the device is already paired", async () => {
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    renderApp({ probe: probeAnswering(false), device, host });
    await screen.findByText("Первый запуск");
    await completeWizard();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(device.pairLocally).not.toHaveBeenCalled();
  });

  it("pairs this computer exactly once under StrictMode", async () => {
    const device = fakeDevice(null);
    const host = fakeHost();
    render(
      <StrictMode>
        <ThemeProvider defaultTheme="dark">
          <App probe={probeAnswering(true)} device={device} host={host} address={ADDRESS} />
        </ThemeProvider>
      </StrictMode>,
    );
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("pairs with an initialized host and opens the office from the floor", async () => {
    const device = fakeDevice(null);
    const host = fakeHost();
    renderApp({ probe: probeAnswering(true), device, host });
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.pairLocally).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(host.officeLogin).toHaveBeenCalledWith({
      login: "admin",
      password: "correct horse battery",
    });

    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(host.officeLogout).toHaveBeenCalledWith("office-session-token");
  });

  it("changes the office user's own password with the session token", async () => {
    const host = fakeHost();
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
    fireEvent.change(await screen.findByLabelText("Текущий пароль"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.change(screen.getByLabelText("Повторите новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    await screen.findByText("Пароль изменён. На других устройствах нужно войти заново.");
    expect(host.officeChangePassword).toHaveBeenCalledWith("office-session-token", {
      currentPassword: "correct horse battery",
      newPassword: "another long password",
    });
  });

  it("routes a password change through the token-scoped call, ending the session", async () => {
    const host = fakeHost();
    host.officeChangePassword.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "office session ended",
        details: { credential: "session" },
      }),
    );
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
    fireEvent.change(await screen.findByLabelText("Текущий пароль"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.change(screen.getByLabelText("Повторите новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.getByText("Сессия офиса закончилась. Войдите снова.")).toBeTruthy();
  });

  it("re-reads the signed-in user when the host answers forbidden", async () => {
    const host = fakeHost();
    host.officeChangePassword.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "not allowed" }),
    );
    host.officeMe.mockResolvedValueOnce({
      ...SESSION.user,
      name: "Ирина Орлова",
      role: "technologist",
    });
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
    fireEvent.change(await screen.findByLabelText("Текущий пароль"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.change(screen.getByLabelText("Повторите новый пароль"), {
      target: { value: "another long password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Недостаточно прав для этого действия.")).toBeTruthy();
    expect(await screen.findByText("Ирина Орлова")).toBeTruthy();
    expect(screen.getByText("технолог")).toBeTruthy();
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
  });

  it("ends the session when leaving the office, so coming back asks to sign in", async () => {
    const host = fakeHost();
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(host.officeLogout).toHaveBeenCalledTimes(1);
    expect(host.officeLogout).toHaveBeenCalledWith("office-session-token");

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(host.officeLogin).toHaveBeenCalledTimes(1);
  });

  it("returns to the floor even when the host cannot be told about leaving", async () => {
    const host = fakeHost();
    host.officeLogout.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
    );
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(host.officeLogout).toHaveBeenCalledWith("office-session-token");
    // The swallow itself is guarded by Vitest failing the run on an unhandled rejection.
    expect(
      screen.queryByText("Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена."),
    ).toBeNull();
  });

  it("adopts a pairing another start of the app already made", async () => {
    const device = fakeDevice(null);
    device.pairLocally.mockRejectedValueOnce(new DeviceError("already_paired", "raced"));
    device.status.mockResolvedValueOnce(null).mockResolvedValueOnce(DEVICE_STATUS);
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Цех")).toBeTruthy();
  });

  it("sends a rejected device back to pairing", async () => {
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.officeLogin.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "unknown or revoked device key",
        details: { credential: "device" },
      }),
    );
    renderApp({ probe: probeAnswering(true), device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("routes a rejected device from the wizard back to pairing", async () => {
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.bootstrap.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "unknown or revoked device key",
        details: { credential: "device" },
      }),
    );
    renderApp({ probe: probeAnswering(false), device, host });
    await screen.findByText("Первый запуск");
    await completeWizard();
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("does not pair again when a rejected bootstrap is corrected and resubmitted", async () => {
    const device = fakeDevice(null);
    const host = fakeHost();
    host.bootstrap
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          status: 422,
          message: "this GLN is already registered to another site",
          details: { field: "org.gln" },
        }),
      )
      .mockResolvedValueOnce({ session: SESSION });
    renderApp({ probe: probeAnswering(false), device, host });
    await screen.findByText("Первый запуск");
    await completeWizard();
    // Rejected: the wizard jumps back to the org step with the field error;
    // the GLN is already valid, so stepping forward again is enough.
    await screen.findByText("Шаг 2 из 5 · Организация");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Шаг 3 из 5 · Номера SSCC");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Шаг 4 из 5 · Линии");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Шаг 5 из 5 · Проверка");
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
    expect(host.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("sends the wizard to the office sign-in when the host was set up meanwhile", async () => {
    const host = fakeHost();
    host.bootstrap.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "already_initialized",
        status: 409,
        message: "the host is already initialized",
      }),
    );
    renderApp({ probe: probeAnswering(false), device: fakeDevice(null), host });
    await completeWizard();
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.getByText("Хост уже настроен. Войдите в офис.")).toBeTruthy();
  });

  it("offers to reset an unreadable device config", async () => {
    const device = fakeDevice(new DeviceError("config_unreadable", "broken"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Настройки подключения повреждены")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить подключение" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("shows a repair failure on the config-error screen and keeps it visible", async () => {
    const device = fakeDevice(new DeviceError("config_unreadable", "broken"));
    device.forget.mockRejectedValueOnce(new DeviceError("storage", "disk full"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Настройки подключения повреждены")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить подключение" }));
    expect(
      await screen.findByText("Не удалось изменить настройки подключения на этом компьютере."),
    ).toBeTruthy();
    expect(screen.getByText("Настройки подключения повреждены")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
  });

  it("explains a missing host and finds it after a retry", async () => {
    const probe = probeAnswering(new HostProbeError("unreachable", "down"), true);
    renderApp({ probe, device: fakeDevice(null), host: fakeHost() });
    expect(await screen.findByText("Служба хоста не отвечает")).toBeTruthy();
    expect(screen.getByText("Нет соединения.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(probe.hello).toHaveBeenCalledWith(ADDRESS);
  });

  it("explains a version mismatch instead of a missing host", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("app_too_old", "old")),
      device: fakeDevice(null),
      host: fakeHost(),
    });
    expect(await screen.findByText("Версии не совпадают")).toBeTruthy();
    expect(
      screen.getByText("Это приложение старее службы «Markiro Хост». Обновите приложение."),
    ).toBeTruthy();
  });

  it("retries a failed pairing by re-probing the host, not just the pairing", async () => {
    const device = fakeDevice(null);
    device.pairLocally.mockRejectedValueOnce(new DeviceError("pair_rejected", "no"));
    const probe = probeAnswering(true);
    renderApp({ probe, device, host: fakeHost() });
    expect(await screen.findByText("Не удалось подключиться к хосту")).toBeTruthy();
    expect(screen.getByText("Хост отказал в подключении этого устройства.")).toBeTruthy();
    const helloCallsBeforeRetry = probe.hello.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(probe.hello.mock.calls.length).toBe(helloCallsBeforeRetry + 1);
    expect(device.pairLocally).toHaveBeenCalledTimes(2);
  });

  it("recovers from a reinstalled host: rejects, reconnects, re-pairs and reaches the floor", async () => {
    // The local host now presents a different identity than the one pinned
    // at pairing (a reinstall).
    const reinstalled = observation(true);
    reinstalled.hello.hostId = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
    reinstalled.fingerprint = "cd".repeat(32);
    const probe = { hello: vi.fn<HostProbe["hello"]>(async () => reinstalled) };
    const newStatus: DeviceStatus = {
      ...DEVICE_STATUS,
      hostId: reinstalled.hello.hostId,
      fingerprint: reinstalled.fingerprint,
    };
    const device = fakeDevice(DEVICE_STATUS, newStatus);
    renderApp({ probe, device, host: fakeHost() });
    expect(
      await screen.findByText(
        "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("shows the version screen, not the floor, for a paired device behind an incompatible host", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("app_too_old", "old")),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
    });
    expect(await screen.findByText("Версии не совпадают")).toBeTruthy();
    expect(
      screen.getByText("Это приложение старее службы «Markiro Хост». Обновите приложение."),
    ).toBeTruthy();
    expect(screen.queryByText("Цех")).toBeNull();
  });
});
