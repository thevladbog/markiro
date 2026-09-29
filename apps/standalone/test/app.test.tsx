import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { App } from "../src/app/App.js";
import type { HostApi } from "../src/host/api.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { DeviceError, type DeviceApi } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type {
  ChangeItem,
  ChangesResponse,
  DeviceStatus,
  HostStatus,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { ENTITY_SET } from "../src/local/reference-sync.js";
import {
  DEVICE_STATUS,
  HOST_ID,
  LINE_ID,
  NEW_STATION,
  observation,
  SESSION,
} from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeHostApi, ORG_PROFILE } from "./support/office.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

const ADDRESS = "https://127.0.0.1:45710";
const REMOTE_ADDRESS = "https://192.168.1.10:45710";
const OTHER_HOST_ID = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const ONLINE: HostStatus = {
  state: "online",
  lastContactAt: 1_790_000_000_000,
  lastError: null,
  seq: 1,
};

function feedPage(rev: number, items: ChangeItem[] = [], hostId = HOST_ID): ChangesResponse {
  return { hostId, rev, hasMore: false, items };
}

function lineItem(rev: number, name: string): ChangeItem {
  return { entity: "lines", id: LINE_ID, rev, deleted: false, data: { name, archived: false } };
}

/** The feed's request did not reach the host. */
function hostDown(): HostError {
  return new HostError({ kind: "transport", code: "unreachable", message: "host down" });
}

/**
 * The shell's link as the test drives it: `watch` reports "online" at once,
 * `status` and `revision` reach the app like shell events. `useHostLink`
 * subscribes in an effect that React runs after the commit showing the
 * screen, so an event waits until the app has subscribed instead of being
 * dropped.
 */
function fakeConnection() {
  let handlers: ConnectionHandlers | null = null;
  const stop = vi.fn();
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      next.onStatus(ONLINE);
      return () => {
        handlers = null;
        stop();
      };
    }),
  };
  const subscribed = () =>
    waitFor(() => {
      if (handlers === null) throw new Error("the app has not subscribed to the link yet");
    });
  return {
    connection,
    stop,
    // An async `act`: what the event sets off (a user refresh, a sync)
    // settles inside it instead of updating the app outside `act`.
    status: async (status: HostStatus) => {
      await subscribed();
      await act(async () => {
        handlers?.onStatus(status);
      });
    },
    revision: async (rev: number) => {
      await subscribed();
      await act(async () => {
        handlers?.onRevision(rev);
      });
    },
  };
}

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
    claim: vi.fn<DeviceApi["claim"]>(async ({ address, fingerprint }) => {
      if (paired) throw new DeviceError("already_paired", "already paired");
      paired = { ...NEW_STATION, hostAddress: address, fingerprint };
      return paired;
    }),
    selectLine: vi.fn<DeviceApi["selectLine"]>(async (lineId) => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      paired = { ...paired, lineId };
      return paired;
    }),
    forget: vi.fn<DeviceApi["forget"]>(async () => {
      paired = null;
      broken = null;
    }),
    // The host's record of the device: by default what the shell keeps.
    refresh: vi.fn<DeviceApi["refresh"]>(async () => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      return paired;
    }),
  };
}

function fakeHost() {
  return fakeHostApi({
    bootstrap: vi.fn<HostApi["bootstrap"]>(async () => ({ session: SESSION })),
    officeLogin: vi.fn<HostApi["officeLogin"]>(async () => SESSION),
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(async () => undefined),
    getChanges: vi.fn<HostApi["getChanges"]>(async () => feedPage(0)),
  });
}

interface Services {
  probe: HostProbe;
  device: DeviceApi;
  host: HostApi;
  connection?: ConnectionApi;
  local?: LocalExecutor;
}

/** The app with fakes; the link stays online and the local database is a fresh one. */
function renderApp({
  connection = fakeConnection().connection,
  local = openLocalDb().executor,
  ...services
}: Services) {
  return render(
    <ThemeProvider defaultTheme="dark">
      <App {...services} connection={connection} local={local} address={ADDRESS} />
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

/**
 * Only `setTimeout` is fake, and it also advances with real time: React's
 * scheduler (`setImmediate`) and Testing Library's polling stay real, and
 * `elapse` jumps the retry waits (the sync's and the device read's).
 */
function fakeRetryTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
}

/** Moves the clock on by `ms`; what the timers set off settles inside `act`. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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
          <App
            probe={probeAnswering(true)}
            device={device}
            host={host}
            connection={fakeConnection().connection}
            local={openLocalDb().executor}
            address={ADDRESS}
          />
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
    // Only `forbidden` should trigger the refresh.
    expect(host.officeMe).not.toHaveBeenCalled();
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

  it("routes a failed refresh after forbidden like any other call", async () => {
    const host = fakeHost();
    host.officeChangePassword.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "forbidden", status: 403, message: "not allowed" }),
    );
    host.officeMe.mockRejectedValueOnce(
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
    const host = fakeHost();
    // Before the repair, a sync still runs against the old pairing: the real
    // shell would report the same certificate mismatch the local probe
    // already sees. After re-pairing, the feed matches the reinstalled host,
    // so the floor is the settled screen here, not a stop at "another host"
    // (which is what a feed still pinned to the old fixture `HOST_ID` would
    // cause once the post-repair sync actually completes).
    host.getChanges.mockImplementation(async () => {
      if (device.pairLocally.mock.calls.length === 0) {
        throw new HostError({
          kind: "transport",
          code: "certificate_mismatch",
          message: "reinstalled",
        });
      }
      return feedPage(1, [], newStatus.hostId);
    });
    renderApp({ probe, device, host });
    expect(
      await screen.findByText(
        "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);

    // Let the sync against the reinstalled host actually finish before
    // checking that the floor is the settled screen, not a fleeting one.
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Цех")).toBeTruthy();
    expect(screen.queryByText("Устройство подключено к другому хосту")).toBeNull();
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

  it("ignores a late answer from a session the user already left", async () => {
    const host = fakeHost();
    let failFirstRead: (error: unknown) => void = () => undefined;
    host.getOrg
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirstRead = reject;
          }),
      )
      .mockResolvedValue(ORG_PROFILE);
    host.officeLogin
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValueOnce({ ...SESSION, token: "second-session-token" });
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await waitFor(() => expect(host.getOrg).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    expect(await screen.findByLabelText("Название организации")).toBeTruthy();

    // The first session's read now fails as an ended session; the second
    // session must not be sent back to the sign-in.
    await act(async () => {
      failFirstRead(
        new HostError({
          kind: "api",
          code: "unauthorized",
          status: 401,
          message: "office session ended",
          details: { credential: "session" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("Вход в офис")).toBeNull();
    expect(screen.getByLabelText("Название организации")).toBeTruthy();
    expect(host.getOrg).toHaveBeenLastCalledWith("second-session-token");
  });

  it("keeps the local copies in step with the host: at start and after every revision", async () => {
    const { db, executor } = openLocalDb();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges
      .mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]))
      .mockResolvedValueOnce(feedPage(43, [lineItem(43, "Линия 1 (упаковка)")]));
    const lineNames = () =>
      Array.from(db.prepare("SELECT name FROM ref_lines").all(), (row) => row.name);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: executor,
    });
    await waitFor(() => expect(lineNames()).toEqual(["Линия 1"]));
    expect(host.getChanges).toHaveBeenCalledWith(0);

    await link.revision(43);
    await waitFor(() => expect(lineNames()).toEqual(["Линия 1 (упаковка)"]));
    expect(host.getChanges).toHaveBeenLastCalledWith(42);
  });

  it("still syncs once when the link's watch itself fails, and reaches the floor", async () => {
    const host = fakeHost();
    const connection: ConnectionApi = {
      watch: vi.fn(async () => {
        throw new Error("the connection task could not be reached");
      }),
    };
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    // The sync starts in the link effect, which runs after the floor shows.
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
    // Exactly once: settle, then check again. React runs passive effects in
    // `setImmediate` tasks, which `waitFor`'s `setTimeout(0)` does not wait for.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });

  it("syncs only after watch settles, not before, even though the fake connection usually resolves at once", async () => {
    const host = fakeHost();
    // Unlike `fakeConnection()`, this `watch` stays pending until resolved by
    // hand: the default fake resolves synchronously, so a reducer or effect
    // that fired `trigger()` too early would still pass the other tests by
    // accident of timing.
    let resolveWatch: ((stop: () => void) => void) | undefined;
    const connection: ConnectionApi = {
      watch: vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            resolveWatch = resolve;
          }),
      ),
    };
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection,
    });
    await screen.findByText("Цех");
    await waitFor(() => expect(connection.watch).toHaveBeenCalledTimes(1));
    // Flush pending microtasks: with `watch` still unresolved, no sync must
    // have started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.getChanges).not.toHaveBeenCalled();

    resolveWatch?.(() => undefined);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
    // Exactly once: settle, then check again (see the test above).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });

  it("stops the link and shows the rejected-device screen when a link status refuses the device's key", async () => {
    const link = fakeConnection();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    await link.status({ state: "offline", lastContactAt: null, lastError: "key_rejected", seq: 2 });
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    expect(
      screen.getByText(
        "Хост не узнаёт ключ этого устройства: устройство могли отключить в офисе или восстановить базу хоста из копии.",
      ),
    ).toBeTruthy();
    // The link stops with the pairing it no longer serves. It stops in the
    // effect cleanup, which React runs after the commit that shows the
    // screen, so the assertion waits for it.
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
  });

  it("stops the link and shows the rejected-device screen when a sync's error refuses the device's key", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "unknown or revoked device key",
        details: { credential: "device" },
      }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    // Same rejection screen and the same stopped link as a link status
    // refusing the key (above) — this time the refusal came from the sync
    // itself, through `shellActionFor`, not through `onStatus`.
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
  });

  it("names the remote host whose certificate changed on the link", async () => {
    const link = fakeConnection();
    renderApp({
      probe: probeAnswering(new HostProbeError("unreachable", "no host on this computer")),
      device: fakeDevice({ ...DEVICE_STATUS, hostAddress: REMOTE_ADDRESS }),
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    await link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "certificate_mismatch",
      seq: 2,
    });
    expect(
      await screen.findByText(
        `Хост по адресу ${REMOTE_ADDRESS} сменился: его сертификат не совпадает с сохранённым при подключении.`,
      ),
    ).toBeTruthy();
  });

  it("stops at another host even when a revision arrives during the first sync", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    let resolveFirst: (page: ChangesResponse) => void = () => undefined;
    host.getChanges.mockImplementationOnce(
      () =>
        new Promise<ChangesResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));

    // A revision arrives while the first sync is still in flight; the
    // scheduler queues a second run for it. That second call would succeed
    // against the default fake host (`feedPage(0)`, `HOST_ID`) and, without
    // the reducer's guard against a further `sync_finished` once
    // `other_host` is already set, would flip the screen back to the floor.
    // The request-count assertion below catches that even with the guard in
    // place: it proves the second run never reached the host at all, not
    // merely that the screen still looks right.
    await link.revision(7);
    resolveFirst(feedPage(7, [], OTHER_HOST_ID));

    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });

  it("stops at a host that is not the paired one and pairs again from scratch", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(7, [], OTHER_HOST_ID));
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    expect(
      screen.getByText(
        `По адресу ${ADDRESS} отвечает хост, к которому это устройство не подключали. Справочники с него не загружаются. Подключите устройство заново.`,
      ),
    ).toBeTruthy();
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(device.pairLocally).toHaveBeenCalledTimes(1);
  });

  it("reads the signed-in user again when the host announces a revision and leaves the open page alone", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getOrg.mockResolvedValue(ORG_PROFILE);
    host.officeMe.mockResolvedValue({ ...SESSION.user, name: "Ирина Орлова" });
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    expect(host.getOrg).toHaveBeenCalledTimes(1);
    expect(host.officeMe).not.toHaveBeenCalled();

    await link.revision(44);
    // The header shows `session.user.name`; waiting for the new name is what
    // makes the negative assertion below meaningful — it proves the
    // refreshed session was actually applied, not merely that nothing fired.
    expect(await screen.findByText("Ирина Орлова")).toBeTruthy();
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
    // Two setImmediate turns, not act(async () => {}): a passive effect that
    // invalidated queries on every session change would run in a later
    // setImmediate task, which only real turns like these wait for.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.getOrg).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Название организации")).toBeTruthy();
  });

  it("has a freshly paired station choose its line before the floor", async () => {
    const device = fakeDevice(null, NEW_STATION);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host });
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.selectLine).toHaveBeenCalledWith(LINE_ID);
  });

  it("sends a station whose key the host refuses while choosing a line to pairing again", async () => {
    const device = fakeDevice(NEW_STATION);
    device.selectLine.mockRejectedValueOnce(new DeviceError("key_rejected", "revoked"));
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("sends a station whose certificate changed while choosing a line to pairing again", async () => {
    const device = fakeDevice(NEW_STATION);
    device.selectLine.mockRejectedValueOnce(new DeviceError("certificate_mismatch", "reinstalled"));
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    expect(
      screen.getByText(
        "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
      ),
    ).toBeTruthy();
  });

  it("shows the link on the floor and in the office header", async () => {
    const link = fakeConnection();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("На связи с хостом")).toBeTruthy();
    await link.status({ state: "offline", lastContactAt: null, lastError: "unreachable", seq: 2 });
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
  });

  it("pairs a second computer by a scanned code, then chooses its line", async () => {
    const payload = `markiro-host:1?h=192.168.1.10&p=45710&f=${"ab".repeat(32)}&c=7K3MQ9XV2D`;
    const probe = {
      hello: vi.fn<HostProbe["hello"]>(async (address) => {
        if (address !== REMOTE_ADDRESS) throw new HostProbeError("unreachable", "no host here");
        return observation(true);
      }),
    };
    const device = fakeDevice(null);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe, device, host });
    fireEvent.click(await screen.findByRole("button", { name: "Подключиться к хосту в сети" }));
    fireEvent.change(await screen.findByLabelText("Код с экрана офиса"), {
      target: { value: payload },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Линия 1" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.claim).toHaveBeenCalledWith({
      address: REMOTE_ADDRESS,
      fingerprint: "ab".repeat(32),
      code: "7K3MQ9XV2D",
      name: "Станция",
    });
    expect(device.pairLocally).not.toHaveBeenCalled();
    expect(host.getChanges).toHaveBeenCalledWith(0);
  });

  it("goes back from pairing in the network to the missing local host", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("unreachable", "down")),
      device: fakeDevice(null),
      host: fakeHost(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Подключиться к хосту в сети" }));
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    expect(await screen.findByText("Служба хоста не отвечает")).toBeTruthy();
  });

  it("offers pairing in the network only to a device that is not paired", async () => {
    renderApp({
      probe: probeAnswering(new HostProbeError("app_too_old", "old")),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
    });
    await screen.findByText("Версии не совпадают");
    expect(screen.queryByRole("button", { name: "Подключиться к хосту в сети" })).toBeNull();
  });
});

describe("reference sync retries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The station without a line says the first sync failed. */
  async function firstSyncFailed(): Promise<void> {
    expect(await screen.findByText("Не удалось получить справочники с хоста.")).toBeTruthy();
  }

  it("retries a failed sync after 2 s, then after 4 s, while the link is online", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges
      .mockRejectedValueOnce(hostDown())
      .mockRejectedValueOnce(hostDown())
      .mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    await elapse(500);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    // The second failure in a row waits twice as long.
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole("button", { name: "Линия 1" })).toBeTruthy();
  });

  it("retries a failed reference sync from the line-select screen, and a request drops the pending retry", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges
      .mockRejectedValueOnce(hostDown())
      .mockRejectedValueOnce(hostDown())
      .mockResolvedValueOnce(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    // The request replaced the first failure's pending retry and ran at
    // once; the streak of failures continues, so the next automatic retry
    // waits 4 s, not 2 s again.
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole("button", { name: "Линия 1" })).toBeTruthy();
  });

  it("stops retrying once a sync succeeds", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the pending retry while the link is down and syncs at once when it is back", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(NEW_STATION),
      host,
      connection: link.connection,
    });
    await firstSyncFailed();
    expect(vi.getTimerCount()).toBe(1);
    await link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "unreachable",
      seq: 2,
    });
    expect(vi.getTimerCount()).toBe(0);
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    // Back online: no need to wait for the next revision event.
    await link.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });

  it("syncs at once on a revision, dropping the pending retry", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown()).mockRejectedValueOnce(hostDown());
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(NEW_STATION),
      host,
      connection: link.connection,
    });
    await firstSyncFailed();
    await link.revision(43);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    // The second failure in a row waits 4 s; the first one's 2 s wait is gone.
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
  });

  it("leaves no retry behind when the app unmounts", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    const view = renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });

  it("leaves no retry behind when a retry finds another host", async () => {
    fakeRetryTimers();
    const host = fakeHost();
    host.getChanges
      .mockRejectedValueOnce(hostDown())
      .mockResolvedValueOnce(feedPage(7, [], OTHER_HOST_ID));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host });
    await firstSyncFailed();
    await elapse(2500);
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no retry behind and syncs no more once the link reports a rejected key", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(NEW_STATION),
      host,
      connection: link.connection,
    });
    await firstSyncFailed();
    expect(vi.getTimerCount()).toBe(1);

    await link.status({ state: "offline", lastContactAt: null, lastError: "key_rejected", seq: 2 });
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);

    await elapse(120_000);
    expect(host.getChanges).toHaveBeenCalledTimes(1);
  });

  it("resets the failure count after a successful run, so the next failure waits 2 s again", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges
      .mockRejectedValueOnce(hostDown())
      .mockResolvedValueOnce(feedPage(42))
      .mockRejectedValueOnce(hostDown())
      // `rev: 42` again, matching the sync state's revision after the first
      // success: a lower `rev` here would read as the host rolling back and
      // cost this run a second, internal `getChanges` call of its own.
      .mockResolvedValueOnce(feedPage(42));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(NEW_STATION),
      host,
      connection: link.connection,
    });
    await firstSyncFailed();
    // The retry succeeds: the failure count resets to zero.
    await elapse(2500);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();

    // A revision starts a new run, independent of the retry; it fails again.
    await link.revision(43);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(3));
    // If the count had not reset, this would be attempt 2 (a 4 s wait); it
    // is attempt 1 again, so the retry comes after 2 s.
    await elapse(500);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
    await elapse(2000);
    expect(host.getChanges).toHaveBeenCalledTimes(4);
  });

  it("does not arm a retry while the link is not online, and syncs at once once it is", async () => {
    fakeRetryTimers();
    let handlers: ConnectionHandlers | null = null;
    const connection: ConnectionApi = {
      watch: vi.fn(async (next: ConnectionHandlers) => {
        handlers = next;
        next.onStatus({ state: "connecting", lastContactAt: null, lastError: null, seq: 1 });
        return () => {
          handlers = null;
        };
      }),
    };
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown()).mockResolvedValueOnce(feedPage(7));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(NEW_STATION), host, connection });
    await firstSyncFailed();
    // Not online: nothing was worth arming a retry against.
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      handlers?.onStatus({
        state: "online",
        lastContactAt: 1_790_000_000_000,
        lastError: null,
        seq: 2,
      });
    });
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });
});

describe("reference sync health on screen", () => {
  it("shows a failed sync on the floor and in the office header until a sync succeeds", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    // Every sync fails, the retries too, until the host answers below.
    host.getChanges.mockRejectedValue(hostDown());
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    expect(
      await screen.findByText("Справочники не обновились — повторим автоматически"),
    ).toBeTruthy();
    expect(screen.getByText("Запрос к хосту не удался.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Справочники не обновились — повторим автоматически")).toBeTruthy();

    host.getChanges.mockResolvedValue(feedPage(43));
    await link.revision(43);
    await waitFor(() =>
      expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull(),
    );
  });

  it("shows how many feed records the copies did not accept", async () => {
    const host = fakeHost();
    const unreadable: ChangeItem = {
      entity: "lines",
      id: LINE_ID,
      rev: 42,
      deleted: false,
      data: { name: "Линия 1", archived: "да" },
    };
    host.getChanges.mockResolvedValueOnce(feedPage(42, [unreadable]));
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    expect(await screen.findByText("Не приняты записи справочников: 1")).toBeTruthy();
    expect(screen.getByText("Цех")).toBeTruthy();
  });

  it("shows the quarantine count after a run that failed with the host away, as after a restart", async () => {
    const { db, executor } = openLocalDb();
    // A previous run already quarantined a record and reached revision 10;
    // this run starts from that state, as a restart would.
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) VALUES (?, ?, ?, ?, ?)",
    ).run("lines", LINE_ID, 10, "archived: invalid_type", 1_790_000_000_000);
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('last_rev', '10'), ('host_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, ENTITY_SET);
    const host = fakeHost();
    host.getChanges.mockRejectedValue(hostDown());
    const connection: ConnectionApi = {
      watch: vi.fn(async (next: ConnectionHandlers) => {
        next.onStatus({ state: "offline", lastContactAt: null, lastError: "unreachable", seq: 1 });
        return () => undefined;
      }),
    };
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection,
      local: executor,
    });
    // The run fails (the host is unreachable and the link is offline), but
    // the count it read before failing still shows.
    expect(await screen.findByText("Не приняты записи справочников: 1")).toBeTruthy();
    expect(screen.getByText("Цех")).toBeTruthy();

    // Reachable offline too: the office header shows it after signing in.
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.getByText("Не приняты записи справочников: 1")).toBeTruthy();
  });
});

describe("the line the office assigns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets every pending effect and timer task settle. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("goes back to choosing a line when the office clears it, and on when the office sets one", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, [lineItem(42, "Линия 1")]));
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));

    device.refresh.mockResolvedValueOnce(NEW_STATION);
    await link.revision(43);
    expect(await screen.findByText("Выбор линии")).toBeTruthy();

    device.refresh.mockResolvedValueOnce(DEVICE_STATUS);
    await link.revision(44);
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.selectLine).not.toHaveBeenCalled();
  });

  it("reads the device once after the first sync and once per revision, one read at a time", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(1);

    let answer: (status: DeviceStatus) => void = () => undefined;
    device.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await link.revision(43);
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(2);
    // Two more revisions while that read is on its way ask for one more read.
    await link.revision(44);
    await link.revision(45);
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      answer(DEVICE_STATUS);
    });
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(3));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "key_rejected",
      "Хост не узнаёт ключ этого устройства: устройство могли отключить в офисе или восстановить базу хоста из копии.",
    ],
    [
      "certificate_mismatch",
      "Хост на этом компьютере сменился: его сертификат не совпадает с сохранённым при подключении.",
    ],
  ] as const)(
    "sends a station whose refresh meets %s to pairing again, and stops the link",
    async (code, reason) => {
      const link = fakeConnection();
      const device = fakeDevice(DEVICE_STATUS);
      device.refresh.mockRejectedValue(new DeviceError(code, "refused"));
      renderApp({
        probe: probeAnswering(true),
        device,
        host: fakeHost(),
        connection: link.connection,
      });
      expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
      expect(screen.getByText(reason)).toBeTruthy();
      await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    },
  );

  it("keeps the station on its line when a refresh cannot reach the host", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.refresh.mockRejectedValue(new DeviceError("unreachable", "host down"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    await screen.findByText("Цех");
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await link.revision(43);
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    await settle();
    expect(screen.getByText("Цех")).toBeTruthy();
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    expect(link.stop).not.toHaveBeenCalled();
  });

  it("retries a failed read of the device after the sync's wait while the link is online", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    // Neither a rejection nor a missing pairing: the station keeps its line
    // and reads again, as a failed sync tries again.
    device.refresh
      .mockRejectedValueOnce(new DeviceError("request_failed", "the host answered with an error"))
      .mockResolvedValueOnce(NEW_STATION);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await elapse(500);
    expect(device.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Цех")).toBeTruthy();
    await elapse(2000);
    expect(device.refresh).toHaveBeenCalledTimes(2);
    // The retried read finds the line the office cleared meanwhile.
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
  });

  it("drops the retry while the link is down and reads at once when it is back", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.refresh
      .mockRejectedValueOnce(new DeviceError("request_failed", "the host answered with an error"))
      .mockResolvedValueOnce(NEW_STATION);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    // The failed read armed a retry.
    expect(vi.getTimerCount()).toBe(1);
    await link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "unreachable",
      seq: 2,
    });
    expect(vi.getTimerCount()).toBe(0);
    await elapse(120_000);
    expect(device.refresh).toHaveBeenCalledTimes(1);
    // Back online: no need to wait for the next revision event.
    await link.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
  });

  it("reads the device again on «sync now»", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const device = fakeDevice(NEW_STATION);
    const host = fakeHost();
    host.getChanges.mockRejectedValueOnce(hostDown());
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    // The first sync failed, so the line-selection screen offers to try again.
    expect(await screen.findByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(1);
    expect(host.getChanges).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    // One request asks for a sync and for a read of the device.
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not retry when there is no pairing", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.refresh.mockRejectedValue(new DeviceError("not_paired", "not paired"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    // No pairing, nothing to read again: no retry is armed.
    expect(vi.getTimerCount()).toBe(0);
    await elapse(60_000);
    expect(device.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Цех")).toBeTruthy();
  });

  it("waits longer after each failed read in a row, and starts over after a read succeeds", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const failure = new DeviceError("request_failed", "the host answered with an error");
    device.refresh
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(DEVICE_STATUS)
      .mockRejectedValueOnce(failure);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    // The first failure waits 2 s; the second, in a row, twice as long.
    await elapse(2500);
    expect(device.refresh).toHaveBeenCalledTimes(2);
    await elapse(2000);
    expect(device.refresh).toHaveBeenCalledTimes(2);
    await elapse(2500);
    expect(device.refresh).toHaveBeenCalledTimes(3);

    // That read succeeded, so the count starts over: after this failure the
    // wait is 2 s again, not 8 s.
    await link.revision(43);
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(4));
    await elapse(500);
    expect(device.refresh).toHaveBeenCalledTimes(4);
    await elapse(2000);
    expect(device.refresh).toHaveBeenCalledTimes(5);
  });

  it("reads the device once when watch fails", async () => {
    const device = fakeDevice(DEVICE_STATUS);
    const connection: ConnectionApi = {
      watch: vi.fn(async () => {
        throw new Error("the connection task could not be reached");
      }),
    };
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), connection });
    expect(await screen.findByText("Цех")).toBeTruthy();
    // The read starts in the link effect, which runs after the floor shows.
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(device.refresh).toHaveBeenCalledTimes(1);
  });
});
