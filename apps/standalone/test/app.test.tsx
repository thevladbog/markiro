import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { App, SIGN_IN_SYNC_GAP_MS } from "../src/app/App.js";
import { useHostLink } from "../src/app/host-link.js";
import {
  createLockdownLifecycle,
  type LockdownCommand,
  type LockdownLifecycle,
} from "../src/app/lockdown.js";
import type { FloorNotice } from "../src/app/shell.js";
import type { FloorAppProps } from "../src/floor/FloorApp.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import {
  DEFAULT_WORKSTATION_SETTINGS,
  saveWorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import type { HardwareApi, WindowsPrinting } from "../src/hardware/hardware.js";
import type { HostApi } from "../src/host/api.js";
import { HostError } from "../src/host/client.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { DeviceError, type DeviceApi } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type {
  ChangeItem,
  ChangesResponse,
  DeviceShift,
  DeviceStatus,
  EnteredShift,
  HostStatus,
  SsccBlockRequest,
} from "../src/host/protocol.js";
import { UNSENT_COUNT_SQL } from "../src/floor/outbox-status.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { ENTITY_SET } from "../src/local/reference-sync.js";
import {
  DEVICE_ID,
  DEVICE_STATUS,
  HOST_ID,
  LINE_ID,
  NEW_STATION,
  observation,
  SESSION,
} from "./support/fixtures.js";
import { km, rows, unsentScans } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb, openLocalDbFile } from "./support/local-db.js";
import { fakeHostApi, ORG_PROFILE } from "./support/office.js";
import { completeWizard, EXPECTED_REQUEST } from "./support/wizard.js";

/**
 * What `onSignOut` each mount of the signed-in floor was given, in order, so
 * a test can call an earlier session's callback late. The real screen is
 * still rendered: this only watches its props.
 */
const signOutHandles = vi.hoisted(() => [] as Array<(notice: FloorNotice | null) => void>);
/** The print runtimes the floor was given, in order (plan ДРВ: which driver printing the app wired in). */
const printingHandles = vi.hoisted(() => [] as Array<FloorAppProps["printing"]>);

vi.mock("../src/floor/FloorApp.js", async (importOriginal) => {
  const actual = await importOriginal<{ FloorApp: ComponentType<FloorAppProps> }>();
  return {
    ...actual,
    FloorApp: (props: FloorAppProps) => {
      if (signOutHandles.at(-1) !== props.onSignOut) signOutHandles.push(props.onSignOut);
      if (printingHandles.at(-1) !== props.printing) printingHandles.push(props.printing);
      return <actual.FloorApp {...props} />;
    },
  };
});

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/** The products, templates and organization the shifts of the floor are made of. */
const CATALOG = (
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/changes-catalog.json", testModuleUrl), "utf8"),
  ) as ChangesResponse
).items;

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
  // The handlers of the last subscription, kept after it stopped: an event of
  // the link that was already on its way when the app stopped listening.
  let latest: ConnectionHandlers | null = null;
  const stop = vi.fn();
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      handlers = next;
      latest = next;
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
    // Events delivered to the subscription that stopped.
    late: {
      status: async (status: HostStatus) => {
        await act(async () => {
          latest?.onStatus(status);
        });
      },
      revision: async (rev: number) => {
        await act(async () => {
          latest?.onRevision(rev);
        });
      },
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
    // A development build's answer; a test sets the installer's role.
    installRole: vi.fn<DeviceApi["installRole"]>(async () => null),
    changeAddress: vi.fn<DeviceApi["changeAddress"]>(async (address) => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      paired = { ...paired, hostAddress: address };
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
  idleTimeoutMs?: number;
  scanSource?: ScanSource;
  hardware?: HardwareApi;
  windowsPrinting?: WindowsPrinting;
  lockdown?: LockdownLifecycle;
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

  /** Outbox records without a receipt: two of this pairing's and one of another's. */
  function withUnsentRecords() {
    const { db, executor } = openLocalDb();
    const insert = db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', 'shift-1', '{}', '2026-10-09T08:00:00.000Z')",
    );
    insert.run("a", HOST_ID, DEVICE_ID);
    insert.run("b", HOST_ID, DEVICE_ID);
    insert.run("c", HOST_ID, OTHER_HOST_ID);
    return executor;
  }

  it("asks before it forgets a rejected device with records not yet sent, and keeps them", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
      local: withUnsentRecords(),
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    expect(
      await screen.findByText(
        "На этом компьютере не отправлено на хост записей смен: 2. После сброса подключения они останутся на диске этого ПК, но отправить их на хост будет нельзя.",
      ),
    ).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined]]);
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined], [{ keepUnsent: true }]]);
  });

  it("counts the records of every pairing when the device config cannot be read", async () => {
    const device = fakeDevice(new DeviceError("config_unreadable", "broken"));
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      local: withUnsentRecords(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Сбросить подключение" }));
    expect(await screen.findByText(/не отправлено на хост записей смен: 3\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined], [{ keepUnsent: true }]]);
  });

  it("asks the same of a device paired to another host than the one that answers, counting its own records", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(7, [], OTHER_HOST_ID));
    renderApp({
      probe: probeAnswering(true),
      device,
      host,
      connection: link.connection,
      local: withUnsentRecords(),
    });
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText(/не отправлено на хост записей смен: 2\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined], [{ keepUnsent: true }]]);
  });

  it("says there are records not yet sent, without a number, when this computer cannot count them", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    const real = withUnsentRecords();
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        sql.includes("FROM outbox")
          ? Promise.reject(new Error("disk"))
          : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
      local,
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    expect(
      await screen.findByText(
        "На этом компьютере есть записи смен, не отправленные на хост. После сброса подключения они останутся на диске этого ПК, но отправить их на хост будет нельзя.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
  });

  it("keeps the confirmation on screen with the reason when the confirmed reset fails too", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget
      .mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"))
      .mockRejectedValueOnce(new DeviceError("storage", "disk full"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
      local: withUnsentRecords(),
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сбросить всё равно" }));
    expect(
      await screen.findByText("Не удалось изменить настройки подключения на этом компьютере."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сбросить всё равно" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(device.forget.mock.calls).toEqual([[undefined], [{ keepUnsent: true }]]);
  });

  it("does not carry a confirmation over to the next refusal of the reconnected device", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
      local: withUnsentRecords(),
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 3 });
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    expect(screen.queryByText(/не отправлено на хост записей смен/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Сбросить всё равно" })).toBeNull();
  });

  /** A restore of the host this pairing has noted and not settled: it still owes its blocks. */
  function owingBlocks(settled: string | null = null) {
    const { db, executor } = openLocalDb();
    db.prepare(
      "INSERT INTO floor_restore_epochs (host_id, device_id, epoch, seen_at, reconciled_at) " +
        "VALUES (?, ?, '5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e', '2026-10-11T08:00:00.000Z', ?)",
    ).run(HOST_ID, DEVICE_ID, settled);
    db.prepare(
      "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
        "from_serial, to_serial, next_serial, received_at) VALUES ('block-1', ?, ?, '460068200', " +
        "0, 3500, 5499, 3600, '2026-10-08T06:00:00.000Z')",
    ).run(HOST_ID, DEVICE_ID);
    return { db, executor };
  }

  /** The host never answers the blocks: the obligation stays owed while the test runs. */
  function hostKeepingTheBlocks() {
    const host = fakeHost();
    host.registerKnownBlocks.mockImplementation(() => new Promise(() => undefined));
    return host;
  }

  const OWED =
    "Хост восстановлен из копии, а эта станция ещё не вернула ему свои блоки номеров SSCC. " +
    "После сброса подключения она их уже не вернёт, и номера, выданные ей после копии, хост не " +
    "узнает. Если станция на связи с хостом, дождитесь, пока в строке состояния цеха пропадёт " +
    "«станция возвращает ему свои блоки номеров SSCC».";

  it("warns before it forgets a pairing that still owes a restored host its blocks", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: hostKeepingTheBlocks(),
      connection: link.connection,
      local: owingBlocks().executor,
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText(OWED)).toBeTruthy();
    expect(device.forget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить, не вернув блоки" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined]]);
  });

  it("asks about the blocks first and about the records not yet sent next", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    const { db, executor } = owingBlocks();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES ('a', ?, ?, 'scan', 'shift-1', '{}', '2026-10-09T08:00:00.000Z')",
    ).run(HOST_ID, DEVICE_ID);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: hostKeepingTheBlocks(),
      connection: link.connection,
      local: executor,
    });
    await screen.findByText("Цех");
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сбросить, не вернув блоки" }));
    expect(await screen.findByText(/не отправлено на хост записей смен: 1\./)).toBeTruthy();
    // The blocks were answered for; the records are a question of their own.
    expect(screen.queryByText(OWED)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить всё равно" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined], [{ keepUnsent: true }]]);
  });

  it("forgets at once when the restore is settled, or the obligation cannot be read", async () => {
    for (const local of [
      owingBlocks("2026-10-11T08:05:00.000Z").executor,
      ((): LocalExecutor => {
        const real = owingBlocks().executor;
        return {
          query: (sql, params, row) =>
            sql.includes("FROM floor_restore_epochs") && sql.startsWith("SELECT epoch")
              ? Promise.reject(new Error("disk"))
              : real.query(sql, params, row),
          transaction: (statements) => real.transaction(statements),
        };
      })(),
    ]) {
      const link = fakeConnection();
      const device = fakeDevice(DEVICE_STATUS);
      const view = renderApp({
        probe: probeAnswering(true),
        device,
        host: hostKeepingTheBlocks(),
        connection: link.connection,
        local,
      });
      await screen.findByText("Цех");
      await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
      fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
      await waitFor(() => expect(device.forget.mock.calls).toEqual([[undefined]]));
      expect(screen.queryByText(OWED)).toBeNull();
      view.unmount();
    }
  });

  it("warns the same on the screen of another host, before anything is forgotten", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = hostKeepingTheBlocks();
    host.getChanges.mockResolvedValueOnce(feedPage(7, [], OTHER_HOST_ID));
    renderApp({
      probe: probeAnswering(true),
      device,
      host,
      connection: link.connection,
      local: owingBlocks().executor,
    });
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText(OWED)).toBeTruthy();
    expect(device.forget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить, не вернув блоки" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(device.forget.mock.calls).toEqual([[undefined]]);
  });

  it("does not carry the warning about the blocks over to the screen of another refusal", async () => {
    const swapped = observation(true);
    swapped.hello.hostId = OTHER_HOST_ID;
    const probe = { hello: vi.fn<HostProbe["hello"]>(async () => swapped) };
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = hostKeepingTheBlocks();
    host.getChanges.mockResolvedValue(feedPage(7));
    renderApp({ probe, device, host, connection: link.connection, local: owingBlocks().executor });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText(OWED)).toBeTruthy();

    host.getChanges.mockResolvedValue(feedPage(8, [], OTHER_HOST_ID));
    await link.revision(8);
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    expect(screen.queryByText(OWED)).toBeNull();
    expect(screen.queryByRole("button", { name: "Сбросить, не вернув блоки" })).toBeNull();
    expect(device.forget).not.toHaveBeenCalled();
  });

  it("does not carry the count of one screen over to the screen of another refusal", async () => {
    // The probe finds another host at the paired address: the device is refused (derived,
    // the link goes on), and a later read of the feed finds the pairing's host elsewhere.
    const swapped = observation(true);
    swapped.hello.hostId = OTHER_HOST_ID;
    const probe = { hello: vi.fn<HostProbe["hello"]>(async () => swapped) };
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    device.forget.mockRejectedValueOnce(new DeviceError("unsent_facts", "unsent"));
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(7));
    renderApp({
      probe,
      device,
      host,
      connection: link.connection,
      local: withUnsentRecords(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Подключить заново" }));
    expect(await screen.findByText(/не отправлено на хост записей смен: 2\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сбросить всё равно" })).toBeTruthy();

    host.getChanges.mockResolvedValue(feedPage(8, [], OTHER_HOST_ID));
    await link.revision(8);
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    // The count belongs to the refusal it was made for.
    expect(screen.queryByText(/не отправлено на хост записей смен/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Сбросить всё равно" })).toBeNull();
    expect(device.forget.mock.calls).toEqual([[undefined]]);
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
    // The copies are bound to this pairing, not only to its host.
    expect({
      ...db.prepare("SELECT value FROM sync_state WHERE key = 'device_id'").get(),
    }).toEqual({ value: DEVICE_STATUS.deviceId });

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
    // Inside `act`: the floor's sign-in reads the local copies meanwhile.
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.getChanges).not.toHaveBeenCalled();

    resolveWatch?.(() => undefined);
    await waitFor(() => expect(host.getChanges).toHaveBeenCalledTimes(1));
    // Exactly once: settle, then check again (see the test above).
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
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
      "INSERT INTO sync_state (key, value) " +
        "VALUES ('last_rev', '10'), ('host_id', ?), ('device_id', ?), ('entity_set', ?)",
    ).run(HOST_ID, DEVICE_STATUS.deviceId, ENTITY_SET);
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

  /**
   * Lets every pending effect and timer task settle, inside `act`: the
   * floor's sign-in reads the local copies after every sync.
   */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
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

  it("reads the device once together with the first sync and once per revision, one read at a time", async () => {
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

  it("reads the device again, with the sync, when the line screen's «Повторить» asks for one", async () => {
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
    // One request (`requestSync`, which a `line_rejected` triggers too) asks
    // for a sync and for a read of the device.
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

  it("lets every read replace the pending retry, so a revision's read does not leave the old wait running", async () => {
    fakeRetryTimers();
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const failure = new DeviceError("request_failed", "the host answered with an error");
    device.refresh.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    renderApp({
      probe: probeAnswering(true),
      device,
      host: fakeHost(),
      connection: link.connection,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    // The first failure armed a retry 2 s away. A revision reads again before
    // it fires; that read fails too, so the wait is now 4 s for two failures
    // in a row, and the first retry must be gone.
    await link.revision(43);
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(2));
    await elapse(2500);
    expect(device.refresh).toHaveBeenCalledTimes(2);
    await elapse(2000);
    expect(device.refresh).toHaveBeenCalledTimes(3);
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

  it("does not retry a failed read on its own when watch failed: the link never comes online", async () => {
    fakeRetryTimers();
    const device = fakeDevice(DEVICE_STATUS);
    device.refresh.mockRejectedValue(
      new DeviceError("request_failed", "the host answered with an error"),
    );
    const connection: ConnectionApi = {
      watch: vi.fn(async () => {
        throw new Error("the connection task could not be reached");
      }),
    };
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), connection });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.refresh).toHaveBeenCalledTimes(1));
    await settle();
    // `online` never became true, so the failed read armed no retry.
    expect(vi.getTimerCount()).toBe(0);
    await elapse(120_000);
    expect(device.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the office on this device", () => {
  it("tells the office which device it runs on, so «Устройства» marks this PC", async () => {
    const host = fakeHost();
    host.listDevices.mockResolvedValue([
      {
        id: DEVICE_STATUS.deviceId,
        kind: "station",
        name: "Рабочее место хоста",
        lineId: LINE_ID,
        appVersion: "0.1.0",
        pairedAt: "2026-09-26T09:15:00Z",
        lastSeenAt: null,
        revokedAt: null,
      },
      {
        id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
        kind: "station",
        name: "Станция упаковки",
        lineId: null,
        appVersion: "0.1.0",
        pairedAt: "2026-09-26T09:30:00Z",
        lastSeenAt: null,
        revokedAt: null,
      },
    ]);
    host.listLines.mockResolvedValue([]);
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    fireEvent.click(await screen.findByRole("link", { name: "Устройства" }));
    const row = (await screen.findByText("Рабочее место хоста")).closest("tr");
    if (!row) throw new Error("no row for this PC");
    expect(within(row).getByText("Этот ПК")).toBeTruthy();
    expect(screen.getAllByText("Этот ПК")).toHaveLength(1);
  });
});

describe("the operator on the floor", () => {
  const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
  /** The PIN 4821 and the badge «MRK-000742» under the site's salt (`proto/fixtures`). */
  const PIN_PHC =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
  const BADGE_PHC =
    "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
  const PEOPLE: ChangeItem[] = [
    {
      entity: "site",
      id: "1",
      rev: 40,
      deleted: false,
      data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
    },
    {
      entity: "operators",
      id: ANNA,
      rev: 41,
      deleted: false,
      data: { login: "0042", name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC },
    },
    {
      entity: "operator_badges",
      id: "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d",
      rev: 42,
      deleted: false,
      data: { operatorId: ANNA, badgePhc: BADGE_PHC, label: null },
    },
  ];
  const SIGNED_IN = "Вошёл: Анна Кузнецова, табельный номер 0042.";
  /** A gap far longer than the burst test's real time, so that its boundaries are never close. */
  const GAP_MS = 30_000;

  function scan(text: string) {
    act(() => {
      for (const key of text) fireEvent.keyDown(window, { key });
      fireEvent.keyDown(window, { key: "Enter" });
    });
  }

  /** The app on a station whose first sync brings the site, Anna and her badge. */
  async function onTheFloor(idleTimeoutMs?: number, signInSyncGapMs?: number) {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      ...(signInSyncGapMs === undefined ? {} : { signInSyncGapMs }),
    });
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    return { link, host };
  }

  it("shows the status bar above the sign-in and the shifts, with the line and the operator", async () => {
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(
      feedPage(43, [...PEOPLE, lineItem(43, "Линия розлива 2")]),
    );
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host });
    const bar = await screen.findByRole("region", { name: "Строка состояния цеха" });
    expect(await within(bar).findByText("Линия розлива 2")).toBeTruthy();
    expect(within(bar).getByText("Никто не вошёл")).toBeTruthy();
    await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру.");
    scan("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Строка состояния цеха" })).getByText(
        "Анна Кузнецова, табельный номер 0042",
      ),
    ).toBeTruthy();
  });

  it("signs an operator in with a badge without asking the host, shows the line's shifts and signs out on request", async () => {
    const { host } = await onTheFloor();
    scan("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    // The sign-in read the local copies only: the one feed request is the start's sync.
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Офис" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    expect(
      await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру."),
    ).toBeTruthy();
    expect(screen.queryByText(/^Оператор вышел/)).toBeNull();
  });

  it("keeps the operator signed in while the host is away", async () => {
    const { link } = await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    await link.status({
      state: "offline",
      lastContactAt: 1_790_000_000_000,
      lastError: "unreachable",
      seq: 2,
    });
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });

  it("signs the operator out after the idle timeout and says so", async () => {
    await onTheFloor(50);
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    expect(await screen.findByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
  });

  it("signs the operator out once a sync brings the host's tombstone for them", async () => {
    const { link, host } = await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    host.getChanges.mockResolvedValueOnce(
      feedPage(43, [{ entity: "operators", id: ANNA, rev: 43, deleted: true }]),
    );
    await link.revision(43);
    expect(
      await screen.findByText(
        "Оператор больше не может входить на станции. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
  });

  it("comes back from the office to the sign-in, with nobody signed in", async () => {
    await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(
      await screen.findByText("Приложите бейдж к сканеру или войдите по табельному номеру."),
    ).toBeTruthy();
  });

  const PROMPT = "Приложите бейдж к сканеру или войдите по табельному номеру.";
  const WRONG_BADGE =
    "Бейдж не найден. Если бейдж новый, дождитесь синхронизации или обратитесь к администратору.";

  /** A scan that is not on the keyboard: the test hands over what the scanner read. */
  function fakeScanSource() {
    let listener: ScanListener | null = null;
    const stop = vi.fn();
    const source: ScanSource = {
      start(next) {
        listener = next;
        return () => {
          listener = null;
          stop();
        };
      },
      clearPendingInput: () => undefined,
      setManualTextEntryActive: () => undefined,
    };
    return {
      source,
      stop,
      read: (raw: string) =>
        act(() => {
          listener?.(raw);
        }),
    };
  }

  /**
   * A local database whose next query waits for `release()`; `wrote()`
   * resolves at the first write after that, which a finished sign-in makes
   * last (it forgets the operator's failures).
   */
  function gatedLocal() {
    const real = openLocalDb().executor;
    let pending: Promise<void> | null = null;
    let open: () => void = () => undefined;
    let written: () => void = () => undefined;
    let wrote = Promise.resolve();
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        const wait = pending;
        pending = null;
        return wait === null
          ? real.query(sql, params, row)
          : wait.then(() => real.query(sql, params, row));
      },
      transaction: (statements) => {
        written();
        return real.transaction(statements);
      },
    };
    return {
      local,
      hold() {
        pending = new Promise<void>((resolve) => {
          open = resolve;
        });
        wrote = new Promise<void>((resolve) => {
          written = resolve;
        });
      },
      release() {
        open();
      },
      wrote: () => wrote,
    };
  }

  /** Two turns of React's effect scheduler, inside `act`: what an effect started has settled. */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
  }

  /** Waits until the running check has finished (the «Проверяем…» line is gone). */
  async function checked(): Promise<void> {
    await waitFor(() => expect(screen.queryByText("Проверяем…")).toBeNull());
  }

  beforeEach(() => {
    signOutHandles.length = 0;
    printingHandles.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes the scans of the scan source it is given, not the keyboard's", async () => {
    const scanner = fakeScanSource();
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      scanSource: scanner.source,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    await checked();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    scanner.read("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  });

  it("reads the shell's COM scanners next to the keyboard when given no scan source", async () => {
    let comListener: ScanListener | null = null;
    const hardware: HardwareApi = {
      printBytes: vi.fn<HardwareApi["printBytes"]>(),
      listUsbPrinters: vi.fn<HardwareApi["listUsbPrinters"]>(),
      listSerialPorts: vi.fn<HardwareApi["listSerialPorts"]>(),
      configureScanners: vi.fn<HardwareApi["configureScanners"]>(),
      closeScanners: vi.fn<HardwareApi["closeScanners"]>(),
      watchScanners: vi.fn<HardwareApi["watchScanners"]>(),
      onScan: vi.fn<HardwareApi["onScan"]>(async (listener) => {
        comListener = listener;
        return () => {
          comListener = null;
        };
      }),
      setSystemAwake: vi.fn<HardwareApi["setSystemAwake"]>(),
    };
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: fakeConnection().connection,
      hardware,
    });
    await screen.findByText(PROMPT);
    await waitFor(() => expect(comListener).not.toBeNull());
    act(() => {
      comListener?.("MRK-000742");
    });
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  });

  /** The shell's hardware as a COM scan subscription is the only thing the app asks of it. */
  function scanHardware() {
    const subscriptions: Array<{ listener: ScanListener; unsubscribed: boolean }> = [];
    const onScan = vi.fn<HardwareApi["onScan"]>(async (listener) => {
      const subscription = { listener, unsubscribed: false };
      subscriptions.push(subscription);
      return () => {
        subscription.unsubscribed = true;
      };
    });
    const hardware: HardwareApi = {
      printBytes: vi.fn<HardwareApi["printBytes"]>(),
      listUsbPrinters: vi.fn<HardwareApi["listUsbPrinters"]>(),
      listSerialPorts: vi.fn<HardwareApi["listSerialPorts"]>(),
      configureScanners: vi.fn<HardwareApi["configureScanners"]>(),
      closeScanners: vi.fn<HardwareApi["closeScanners"]>(),
      watchScanners: vi.fn<HardwareApi["watchScanners"]>(),
      onScan,
      setSystemAwake: vi.fn<HardwareApi["setSystemAwake"]>(),
    };
    return { hardware, onScan, subscriptions };
  }

  it("leaves no COM subscription behind when the app goes away, StrictMode's double start included", async () => {
    const shell = scanHardware();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    const { unmount } = render(
      <StrictMode>
        <ThemeProvider defaultTheme="dark">
          <App
            probe={probeAnswering(true)}
            device={fakeDevice(DEVICE_STATUS)}
            host={host}
            connection={fakeConnection().connection}
            local={openLocalDb().executor}
            address={ADDRESS}
            hardware={shell.hardware}
          />
        </ThemeProvider>
      </StrictMode>,
    );
    await screen.findByText(PROMPT);
    await waitFor(() => expect(shell.subscriptions.length).toBeGreaterThan(1));
    unmount();
    await flush();
    expect(shell.subscriptions.length).toBeGreaterThan(1);
    expect(shell.subscriptions.filter((subscription) => !subscription.unsubscribed)).toEqual([]);
  });

  it("does not subscribe to the COM scanners when it is given a scan source", async () => {
    const shell = scanHardware();
    const scanner = fakeScanSource();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: fakeConnection().connection,
      scanSource: scanner.source,
      hardware: shell.hardware,
    });
    await screen.findByText(PROMPT);
    await flush();
    expect(shell.onScan).not.toHaveBeenCalled();
    scanner.read("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  });

  it("takes a keyboard scan while it also listens to the COM scanners", async () => {
    const shell = scanHardware();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: fakeConnection().connection,
      hardware: shell.hardware,
    });
    await screen.findByText(PROMPT);
    await waitFor(() => expect(shell.subscriptions.length).toBeGreaterThan(0));
    scan("MRK-000742");
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  });

  it("gives the shell the COM scanners of the workstation's settings when it starts", async () => {
    const { executor } = openLocalDb();
    await saveWorkstationSettings(executor, {
      ...DEFAULT_WORKSTATION_SETTINGS,
      scanners: [{ port: "COM3", baud: 9600 }],
    });
    const { hardware } = fakeHardware();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      local: executor,
      hardware,
    });
    await waitFor(() =>
      expect(hardware.configureScanners).toHaveBeenCalledWith([{ port: "COM3", baud: 9600 }]),
    );
  });

  it("lets the computer sleep when it starts: a reloaded webview's request is let go", async () => {
    const { hardware } = fakeHardware();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      hardware,
    });
    await waitFor(() => expect(hardware.setSystemAwake).toHaveBeenCalledWith(false));
    expect(hardware.setSystemAwake).not.toHaveBeenCalledWith(true);
  });

  it("starts the wait again on a touch of the screen, not only on a key", async () => {
    fakeRetryTimers();
    await onTheFloor(4_000);
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    await flush();
    // The fake clock also runs with real time (`shouldAdvanceTime`), so the
    // margins on both sides of the touch are 1 500 ms: the touch lands before
    // the first wait would end (4 000), and the check lands before the
    // restarted one would (2 500 + 4 000).
    await elapse(2_500);
    act(() => {
      fireEvent.touchStart(window);
    });
    await elapse(2_500);
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
    await elapse(1_700);
    expect(screen.getByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
  });

  it("does not start the wait again on every event of the link", async () => {
    fakeRetryTimers();
    const { link } = await onTheFloor(2_000);
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    await flush();
    await elapse(800);
    await link.status({ state: "offline", lastContactAt: 1, lastError: "unreachable", seq: 2 });
    await elapse(800);
    await link.status({ ...ONLINE, seq: 3 });
    // 2 200 ms after the sign-in, 1 400 after the first event: only the
    // wait the sign-in started can have run out by now.
    await elapse(600);
    expect(screen.getByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
  });

  it("ends only its own session: an earlier session's late sign-out leaves the next one", async () => {
    await onTheFloor();
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    await flush();
    const earlier = signOutHandles.at(-1);
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    await screen.findByText(SIGNED_IN);
    await flush();
    expect(signOutHandles).toHaveLength(2);
    expect(earlier).toBeDefined();
    // Same operator, same id: only the session tells the two calls apart.
    act(() => {
      earlier?.("idle");
    });
    await flush();
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
    expect(screen.queryByText(/^Оператор вышел/)).toBeNull();
    act(() => {
      signOutHandles.at(-1)?.("idle");
    });
    expect(await screen.findByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
  });

  it("asks the host for a sync at most once in a while, however many stray scans come", async () => {
    fakeRetryTimers();
    const { host } = await onTheFloor(undefined, GAP_MS);
    host.getChanges.mockResolvedValue(feedPage(42));
    expect(host.getChanges).toHaveBeenCalledTimes(1);
    for (const code of ["NOT-A-BADGE-1", "NOT-A-BADGE-2", "NOT-A-BADGE-3", "NOT-A-BADGE-4"]) {
      scan(code);
      await checked();
    }
    expect(screen.getByText(WRONG_BADGE)).toBeTruthy();
    // The first asked at once; the other three became one more at the end of the wait.
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    // The fake clock also runs with real time: a long gap leaves the burst
    // and each boundary seconds of slack, not the checks' own duration.
    await elapse(GAP_MS - 5_000);
    expect(host.getChanges).toHaveBeenCalledTimes(2);
    await elapse(10_000);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
    await elapse(2 * GAP_MS);
    expect(host.getChanges).toHaveBeenCalledTimes(3);
  });

  it("waits two seconds between the sign-in's syncs unless it is told otherwise", async () => {
    expect(SIGN_IN_SYNC_GAP_MS).toBe(2_000);
    fakeRetryTimers();
    const { host } = await onTheFloor();
    host.getChanges.mockResolvedValue(feedPage(42));
    const timers = vi.spyOn(globalThis, "setTimeout");
    scan("NOT-A-BADGE-1");
    await checked();
    expect(timers).toHaveBeenCalledWith(expect.any(Function), SIGN_IN_SYNC_GAP_MS);
    timers.mockRestore();
  });

  it("leaves no wait behind when the app is gone", async () => {
    fakeRetryTimers();
    const view = renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
    });
    await screen.findByText("Справочники ещё не загружены с хоста.", { exact: false });
    scan("NOT-A-BADGE-1");
    await checked();
    scan("NOT-A-BADGE-2");
    await checked();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not keep a sign-in whose answer comes after the probe moved the screen off the floor and back", async () => {
    const gate = gatedLocal();
    let failProbe: (error: HostProbeError) => void = () => undefined;
    const first = new Promise<never>((_, reject) => {
      failProbe = reject;
    });
    const hello = vi
      .fn<HostProbe["hello"]>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(observation(true));
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: { hello },
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: gate.local,
    });
    await screen.findByText(PROMPT);
    gate.hold();
    scan("MRK-000742");
    // The probe answers while the check waits: the host is too old for this app.
    await act(async () => {
      failProbe(new HostProbeError("host_too_old", "old"));
    });
    await screen.findByText("Служба «Markiro Хост» старее этого приложения.", { exact: false });
    // The floor comes back with a sign-in screen of its own, and only then
    // does the first screen's check finish: it ended with its screen.
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    await screen.findByText(PROMPT);
    await act(async () => {
      gate.release();
      await gate.wrote();
    });
    await flush();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });

  it("drops what was typed when the office moves the station to another line", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device,
      host,
      connection: link.connection,
    });
    await screen.findByText(PROMPT);
    fireEvent.click(screen.getByRole("button", { name: "Войти по табельному номеру" }));
    expect(await screen.findByText("Наберите табельный номер.")).toBeTruthy();
    device.refresh.mockResolvedValueOnce({
      ...DEVICE_STATUS,
      lineId: "5d1f6a52-0b7e-4c0e-8f51-3a4b9c2d7e10",
    });
    await link.revision(43);
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    expect(screen.queryByText("Наберите табельный номер.")).toBeNull();
  });

  it("does not sign an operator in on the new line when the answer lands in the batch of the line change", async () => {
    const gate = gatedLocal();
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device,
      host,
      connection: link.connection,
      local: gate.local,
    });
    await screen.findByText(PROMPT);
    gate.hold();
    scan("MRK-000742");
    await flush();
    let moveStation: (status: DeviceStatus) => void = () => undefined;
    device.refresh.mockReturnValueOnce(
      new Promise<DeviceStatus>((resolve) => {
        moveStation = resolve;
      }),
    );
    await link.revision(43);
    // One batch: the office's move reaches the shell first, and the check of
    // the badge answers before React has rendered it, so neither the screen's
    // own line nor its `key` have changed yet.
    await act(async () => {
      moveStation({ ...DEVICE_STATUS, lineId: "5d1f6a52-0b7e-4c0e-8f51-3a4b9c2d7e10" });
      gate.release();
      await gate.wrote();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await flush();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(screen.queryByRole("button", { name: "Сменить оператора" })).toBeNull();
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });

  /** The line's planned shift as the host lists it, and as it answers its opening. */
  const PLANNED: DeviceShift = {
    id: "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a",
    number: "OCT26-005/S",
    status: "planned",
    mode: "aggregation",
    palletsEnabled: false,
    createdFrom: "station",
    lineId: LINE_ID,
    productId: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
    productName: "Молоко 3,2% 0,9 л",
    productGtin14: "04600682000013",
    counterpartyName: null,
    productionDate: "2026-10-09",
    plannedQty: null,
    boxCapacity: 12,
    boxTemplateId: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
    ownerDeviceId: null,
    openedAt: null,
    closedAt: null,
  };
  const OPENED: EnteredShift = {
    ...PLANNED,
    status: "active",
    ownerDeviceId: DEVICE_ID,
    openedAt: "2026-10-09T06:00:00Z",
    snapshot: {
      product: {
        id: PLANNED.productId,
        gtin14: "04600682000013",
        name: "Молоко 3,2% 0,9 л",
        printName: null,
        chzProductGroupCode: 8,
        shelfLifeDays: 10,
      },
      boxTemplate: {
        id: PLANNED.boxTemplateId,
        name: "Молоко 58×40",
        rev: 62,
        spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "tspl", elements: [] },
      },
      issuerPrefix: "460068200",
      counterpartyName: null,
    },
  };

  /** Anna signed in, in the line's shift, on a station whose host lists it. */
  async function inTheShift(
    probe: HostProbe = probeAnswering(true),
    extra: Pick<Services, "windowsPrinting"> = {},
  ) {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    host.enterShift.mockResolvedValue(OPENED);
    renderApp({ probe, device, host, connection: link.connection, ...extra });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    return { link, device, host };
  }

  it("shows the shifts the host lists for the line and opens one into its work screen", async () => {
    const { host } = await inTheShift();
    expect(host.enterShift).toHaveBeenCalledWith(PLANNED.id);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });

  it("gives the floor a print runtime over the shell's driver printing it was given (plan ДРВ)", async () => {
    const windowsPrinting: WindowsPrinting = {
      supportsWindowsPrinting: vi.fn(async () => true),
      printWindowsRaster: vi.fn(async () => ({
        sent: false as const,
        code: "unsupported" as const,
      })),
      getWindowsPrintJob: vi.fn(async () => ({ state: "absent" as const })),
    };
    await inTheShift(probeAnswering(true), { windowsPrinting });
    const printing = printingHandles.at(-1);
    expect(printing).toBeDefined();
    await expect(printing?.supportsWindowsDriver()).resolves.toBe(true);
    expect(windowsPrinting.supportsWindowsPrinting).toHaveBeenCalledTimes(1);
  });

  it("keeps the operator in the shift when the host refuses the key, and refuses the device once they leave", async () => {
    const { link } = await inTheShift();
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    // The link stops at once: nothing more reaches a host that refused us.
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("moves the station to the office's new line only after the operator's work, and says so", async () => {
    const { link, device, host } = await inTheShift();
    // The sync that the event sets off keeps the operator: it is the move, not a removal, that ends the session.
    host.getChanges.mockResolvedValue(feedPage(42, PEOPLE));
    device.refresh.mockResolvedValue({
      ...DEVICE_STATUS,
      lineId: "5d1f6a52-0b7e-4c0e-8f51-3a4b9c2d7e10",
    });
    await link.revision(43);
    expect(await screen.findByText("Станция перешла на другую линию. Войдите снова.")).toBeTruthy();
    expect(screen.queryByText("Смена OCT26-005/S")).toBeNull();
  });

  it("shows a name the office changed without ending the operator's session", async () => {
    const { link, host } = await inTheShift();
    host.getChanges.mockResolvedValueOnce(
      feedPage(43, [
        {
          entity: "operators",
          id: ANNA,
          rev: 43,
          deleted: false,
          data: { login: "0042", name: "Анна Петрова", role: null, pinPhc: PIN_PHC },
        },
      ]),
    );
    await link.revision(43);
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(await within(bar).findByText("Анна Петрова, табельный номер 0042")).toBeTruthy();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
  });

  it("sends nothing to a host that refused the key, however the link goes on, and keeps the operator in the shift", async () => {
    const { link, device, host } = await inTheShift();
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    const reached = () => [
      host.getChanges.mock.calls.length,
      device.refresh.mock.calls.length,
      host.getDeviceShifts.mock.calls.length,
    ];
    const before = reached();
    // Events of the stopped link, and time for any retry, reach no call.
    await link.late.revision(44);
    await link.late.status({ ...ONLINE, seq: 3 });
    await flush();
    expect(reached()).toEqual(before);
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    expect(reached()).toEqual(before);
  });

  it("takes a code of the product in the work screen, asks the host about it, and delivers the record", async () => {
    const { host } = await inTheShift();
    // The screen listens from the commit that also asks for serials on entry.
    await waitFor(() => expect(host.requestSsccBlock).toHaveBeenCalled());
    host.checkCode.mockResolvedValue({ status: "free" });
    host.requestSsccBlock.mockRejectedValue(new Error("not wanted here"));
    host.sendFacts.mockImplementation(async (records) =>
      records.map((record) => ({
        id: (record as { id: string }).id,
        outcome: "accepted" as const,
      })),
    );
    scan(km("APP1"));
    await waitFor(() => expect(host.checkCode).toHaveBeenCalledTimes(1));
    expect(host.checkCode.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    await waitFor(() => expect(value("Принято в смене")).toBe("1"));
    // The write asked the link to deliver at once, and the receipt came back.
    await waitFor(() => expect(host.sendFacts).toHaveBeenCalled());
    const sent = host.sendFacts.mock.calls.flatMap(([records]) => records);
    expect(sent).toContainEqual(expect.objectContaining({ kind: "scan", shiftId: PLANNED.id }));
    await waitFor(() => expect(value("Не отправлено")).toBe("0"));
    // The screen asked the host for serials on entry (the station had no block).
    expect(host.requestSsccBlock).toHaveBeenCalled();
  });

  it("keeps the operator in the shift when a sync finds another host, and shows that host once they leave", async () => {
    const { link, host } = await inTheShift();
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    const marker =
      "По адресу хоста отвечает другой хост: записи не отправляются. Выйдите из смены и подключите станцию заново.";
    expect(within(bar).queryByText(marker)).toBeNull();
    host.getChanges.mockResolvedValue(feedPage(43, [], OTHER_HOST_ID));
    await link.revision(43);
    // The link stops at once: nothing more reaches a host that is not ours.
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    expect(await within(bar).findByText(marker)).toBeTruthy();
    expect(within(bar).queryByText("На связи с хостом")).toBeNull();
    // The shift is still on the screen: a write in flight is not cut off by the forget screen.
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.queryByText("Устройство подключено к другому хосту")).toBeNull();
    const reached = host.getChanges.mock.calls.length;
    await link.late.revision(44);
    await link.late.status({ ...ONLINE, seq: 3 });
    expect(host.getChanges.mock.calls.length).toBe(reached);
    // The line goes on, offline-first: the code is taken, and the other host is asked nothing.
    host.checkCode.mockClear();
    scan(km("OTHER1"));
    await waitFor(() =>
      expect(screen.getByText("Принято в смене").nextElementSibling?.textContent).toBe("1"),
    );
    expect(host.checkCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Устройство подключено к другому хосту")).toBeTruthy();
    expect(screen.queryByText("Смена OCT26-005/S")).toBeNull();
  });

  it("keeps the operator in the shift when the start-up probe answers late, and applies its answer once they leave", async () => {
    const swapped = observation(true);
    swapped.hello.hostId = OTHER_HOST_ID;
    let answer: (found: typeof swapped) => void = () => undefined;
    const probe: HostProbe = {
      hello: vi.fn<HostProbe["hello"]>(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
    };
    await inTheShift(probe);
    await act(async () => {
      answer(swapped);
    });
    // Not the probe's screen, in the middle of the work.
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("says in the status bar that the host refused the station while the operator is still in the shift, whichever way the refusal came", async () => {
    // The refusal comes from a CALL (the device read), not from the link's status: the
    // link goes down while its last status stays «online», so the bar must say it.
    const { link, device } = await inTheShift();
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    const marker =
      "Хост отказал этой станции: записи не отправляются. Выйдите из смены и подключите станцию заново.";
    expect(within(bar).queryByText(marker)).toBeNull();
    device.refresh.mockRejectedValueOnce(new DeviceError("key_rejected", "the key is refused"));
    await link.revision(43);
    expect(await within(bar).findByText(marker)).toBeTruthy();
    // The link was torn down: the bar says so, not the status the link last had.
    expect(within(bar).queryByText("На связи с хостом")).toBeNull();
    expect(within(bar).getByText(/^Нет связи с хостом/)).toBeTruthy();
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("names the device and the shift in the status bar, and drops the shift when the operator leaves it", async () => {
    await inTheShift();
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(within(bar).getByText("Станция на линии 1")).toBeTruthy();
    expect(await within(bar).findByText("OCT26-005/S")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(within(bar).queryByText("OCT26-005/S")).toBeNull();
    expect(within(bar).getByText("Станция на линии 1")).toBeTruthy();
  });

  it("warns in the status bar that the office's change of the device was not saved, until a read is saved", async () => {
    const link = fakeConnection();
    const device = fakeDevice(DEVICE_STATUS);
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, PEOPLE));
    renderApp({ probe: probeAnswering(true), device, host, connection: link.connection });
    await screen.findByText(PROMPT);
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(within(bar).queryByText(/не удалось сохранить на этом компьютере/)).toBeNull();
    device.refresh.mockRejectedValueOnce(new DeviceError("storage", "disk full"));
    await link.revision(43);
    expect(await within(bar).findByText(/не удалось сохранить на этом компьютере/)).toBeTruthy();
    await link.revision(44);
    await waitFor(() =>
      expect(within(bar).queryByText(/не удалось сохранить на этом компьютере/)).toBeNull(),
    );
  });

  it("lists a shift the host announces after the operator signed in", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([]);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    expect(
      await screen.findByText(
        "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
      ),
    ).toBeTruthy();
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    await link.revision(43);
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(screen.getByText("OCT26-005/S")).toBeTruthy();
  });

  it("refuses the device at once when the key is refused outside a shift", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    await screen.findByRole("button", { name: "Открыть" });
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
  });

  it("enters a shift the office closed on the way, to finish it, and holds a refused key until it is left", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValue(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    let answer: (shift: EnteredShift) => void = () => undefined;
    host.enterShift.mockImplementation(
      () =>
        new Promise<EnteredShift>((resolve) => {
          answer = resolve;
        }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(host.enterShift).toHaveBeenCalledTimes(1));
    // The host's list that says «closed» lands before the answer of the entry.
    host.getDeviceShifts.mockResolvedValue([
      { ...PLANNED, status: "closed", closedAt: "2026-10-09T18:00:00Z" },
    ]);
    await link.revision(43);
    await act(async () => {
      answer(OPENED);
    });
    // The station entered it before the office closed it: it is finished here, with no new code.
    expect(await screen.findByText("Смену закрыли в офисе")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Выйти из смены" })).toBeTruthy();
    // The shell is told of work, so a refused key waits until the operator leaves the shift.
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("makes a shift of a scanned product through the host and works in it", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(67, [...PEOPLE, ...CATALOG]));
    host.createDeviceShift.mockImplementation(async (body) => ({
      ...PLANNED,
      productId: body.productId,
      boxTemplateId: body.boxTemplateId,
      productionDate: body.productionDate,
      boxCapacity: body.boxCapacity ?? PLANNED.boxCapacity,
      plannedQty: body.plannedQty ?? null,
    }));
    host.enterShift.mockResolvedValue(OPENED);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    // The scanner listens once the form's effect has run.
    await screen.findByLabelText("Название товара");
    await flush();
    scan("4600682000013");
    expect(await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(host.createDeviceShift).toHaveBeenCalledTimes(1);
    expect(host.createDeviceShift.mock.calls[0]?.[0]).toMatchObject({
      productId: PLANNED.productId,
      boxTemplateId: PLANNED.boxTemplateId,
      boxCapacity: 12,
      plannedQty: null,
      counterpartyId: null,
    });
    expect(host.enterShift).toHaveBeenCalledWith(PLANNED.id);
    // A refusal that comes now waits for the operator to leave this shift.
    await link.status({ ...ONLINE, lastError: "key_rejected", seq: 2 });
    await waitFor(() => expect(link.stop).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Хост не принимает это устройство")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("keeps scanning while the host is away, and sends every record in order once it is back", async () => {
    const link = fakeConnection();
    const database = openLocalDb();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    host.enterShift.mockResolvedValue(OPENED);
    host.requestSsccBlock.mockImplementation(async (request) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    }));
    host.sendFacts.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host away" }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: database.executor,
    });
    await screen.findByText(PROMPT);
    scan("MRK-000742");
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    await link.status({ state: "offline", lastContactAt: 1, lastError: "unreachable", seq: 2 });
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    const unsent = () => within(bar).getByText("Не отправлено").nextElementSibling?.textContent;
    for (const serial of ["A1", "A2", "A3"]) {
      scan(km(serial));
      await screen.findByText(`Принято: в коробе ${serial.slice(1)} из 12.`);
    }
    await waitFor(() => expect(unsent()).toBe("3"));
    host.sendFacts.mockImplementation(async (records) =>
      records.map((record) => ({
        id: (record as { id: string }).id,
        outcome: "accepted" as const,
      })),
    );
    // The three records waited in the outbox, unsent, in the order of the scans.
    const kept = rows(database.db, "SELECT id FROM outbox ORDER BY seq").map((row) => row["id"]);
    expect(kept).toHaveLength(3);
    await link.status({ ...ONLINE, seq: 3 });
    await waitFor(() => expect(unsent()).toBe("0"));
    const sent = host.sendFacts.mock.calls.at(-1)?.[0] ?? [];
    expect(
      sent.map((record) => {
        const { kind, data } = record as { kind: string; data: { code: { serial: string } } };
        return [kind, data.code.serial];
      }),
    ).toEqual([
      ["scan", "A1"],
      ["scan", "A2"],
      ["scan", "A3"],
    ]);
    // Exactly the records kept, each once, and each with the host's receipt.
    expect(sent.map((record) => (record as { id: string }).id)).toEqual(kept);
    expect(rows(database.db, "SELECT outcome FROM outbox ORDER BY seq")).toEqual([
      { outcome: "accepted" },
      { outcome: "accepted" },
      { outcome: "accepted" },
    ]);
  });

  it("finds its request, its full box and its records after a restart, and finishes the work once the host is back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markiro-app-restart-"));
    try {
      const path = join(dir, "station.db");
      // The host issues a block once per request id; the first answer never arrives.
      const asked: string[] = [];
      const issue = async (request: SsccBlockRequest) => {
        asked.push(request.requestId);
        if (asked.length === 1) throw hostDown();
        return {
          id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
          issuerPrefix: request.issuerPrefix,
          extension: request.extension,
          fromSerial: 1500,
          toSerial: 3499,
        };
      };
      const unsentOf = () => screen.getByText("Не отправлено").nextElementSibling?.textContent;

      // ---- The first start: the host is there for the entry only.
      const first = openLocalDbFile(path);
      const link = fakeConnection();
      const host = fakeHost();
      host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
      host.getDeviceShifts.mockResolvedValue([PLANNED]);
      host.enterShift.mockResolvedValue(OPENED);
      host.requestSsccBlock.mockImplementation(issue);
      host.sendFacts.mockRejectedValue(hostDown());
      const view = renderApp({
        probe: probeAnswering(true),
        device: fakeDevice(DEVICE_STATUS),
        host,
        connection: link.connection,
        local: first.executor,
      });
      await screen.findByText(PROMPT);
      scan("MRK-000742");
      fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
      expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
      // The entry asked for serials; the request is kept for the answer that was lost.
      await waitFor(() => expect(asked).toHaveLength(1));
      await waitFor(() =>
        expect(rows(first.db, "SELECT request_id FROM floor_block_requests")).toEqual([
          { request_id: asked[0] },
        ]),
      );
      await link.status({ state: "offline", lastContactAt: 1, lastError: "unreachable", seq: 2 });
      for (let n = 1; n <= 12; n += 1) {
        scan(km(`B${String(n).padStart(2, "0")}`));
        await screen.findByText(`Принято: в коробе ${n} из 12.`);
      }
      // The twelfth fills the box; with no serial and no host the box stays open, and the screen says why.
      expect(await screen.findByText("Нет номеров SSCC: короб не закрыт")).toBeTruthy();
      await waitFor(() => expect(unsentOf()).toBe("12"));
      expect(rows(first.db, "SELECT item_count, closed_at FROM floor_boxes")).toEqual([
        { item_count: 12, closed_at: null },
      ]);
      // Nothing was acknowledged: the host did not take a record while it was away.
      expect(rows(first.db, "SELECT count(*) AS n FROM outbox WHERE acked_at IS NULL")).toEqual([
        { n: 12 },
      ]);
      view.unmount();
      first.db.close();

      // ---- The computer starts again over the same file; the host is back.
      const second = openLocalDbFile(path);
      const back = fakeConnection();
      const host2 = fakeHost();
      host2.getChanges.mockResolvedValue(feedPage(42));
      host2.getDeviceShifts.mockResolvedValue([
        { ...PLANNED, status: "active", ownerDeviceId: DEVICE_ID, openedAt: OPENED.openedAt },
      ]);
      host2.enterShift.mockResolvedValue(OPENED);
      host2.requestSsccBlock.mockImplementation(issue);
      host2.sendFacts.mockImplementation(async (records) =>
        records.map((record) => ({
          id: (record as { id: string }).id,
          outcome: "accepted" as const,
        })),
      );
      renderApp({
        probe: probeAnswering(true),
        device: fakeDevice(DEVICE_STATUS),
        host: host2,
        connection: back.connection,
        local: second.executor,
      });
      await screen.findByText(PROMPT);
      scan("MRK-000742");
      fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
      expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
      // The entry repeats the request it kept, whole, and closes the full box on the block it brings.
      await waitFor(() => expect(asked).toHaveLength(2));
      expect(asked[1]).toBe(asked[0]);
      await waitFor(() =>
        expect(rows(second.db, "SELECT serial, item_count FROM floor_boxes")).toEqual([
          { serial: 1500, item_count: 12 },
        ]),
      );
      expect(rows(second.db, "SELECT request_id FROM floor_block_requests")).toEqual([]);
      expect(rows(second.db, "SELECT next_serial FROM floor_sscc_blocks")).toEqual([
        { next_serial: 1501 },
      ]);
      // Everything the first start kept goes once, in order, and nothing waits any more.
      await waitFor(() => expect(unsentOf()).toBe("0"));
      const delivered = host2.sendFacts.mock.calls.flatMap(([records]) =>
        records.map((record) => record as { id: string; kind: string }),
      );
      const stored = rows(second.db, "SELECT id, kind, outcome FROM outbox ORDER BY seq");
      expect(delivered.map((record) => record.id)).toEqual(stored.map((row) => row["id"]));
      expect(delivered.map((record) => record.kind)).toEqual([
        ...Array.from({ length: 12 }, () => "scan"),
        "box_closed",
      ]);
      expect(stored.every((row) => row["outcome"] === "accepted")).toBe(true);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes the shift while the host is away; its close goes last once the host is back, and the list lets it go", async () => {
    const link = fakeConnection();
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    host.getDeviceShifts.mockResolvedValue([PLANNED]);
    host.enterShift.mockResolvedValue(OPENED);
    host.requestSsccBlock.mockImplementation(async (request) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    }));
    // The panels guard a press for 400 ms after their view changed (a double tap): the
    // test lets that time pass by moving the clock they read, never by waiting.
    const realNow = performance.now.bind(performance);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + elapsed);
    // The pause comes before the press, and nothing is awaited after it: what the press sets
    // off settles inside the next `findBy*`, not between two awaits outside `act`.
    const afterPause = async (name: string) => {
      const button = await screen.findByRole("button", { name });
      elapsed += 1_000;
      return button;
    };
    try {
      renderApp({
        probe: probeAnswering(true),
        device: fakeDevice(DEVICE_STATUS),
        host,
        connection: link.connection,
      });
      await screen.findByText(PROMPT);
      scan("MRK-000742");
      fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
      expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
      // The block arrived with the link up; then the host goes away.
      await waitFor(() => expect(host.requestSsccBlock).toHaveBeenCalled());
      host.sendFacts.mockRejectedValue(
        new HostError({ kind: "transport", code: "unreachable", message: "host away" }),
      );
      await link.status({ state: "offline", lastContactAt: 1, lastError: "unreachable", seq: 2 });
      for (const serial of ["A1", "A2"]) {
        scan(km(serial));
        await screen.findByText(`Принято: в коробе ${serial.slice(1)} из 12.`);
      }
      fireEvent.click(await afterPause("Закрыть короб"));
      fireEvent.click(await afterPause("Закрыть короб"));
      // No printer on this computer: the label fails, and the operator goes on without it.
      expect(await screen.findByText("Этикетка короба не напечатана")).toBeTruthy();
      fireEvent.click(await afterPause("Продолжить без этикетки"));
      expect(await screen.findByText("Продолжить без этикетки?")).toBeTruthy();
      fireEvent.click(await afterPause("Продолжить без этикетки"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Закрыть смену" }).hasAttribute("disabled")).toBe(
          false,
        ),
      );
      fireEvent.click(await afterPause("Закрыть смену"));
      fireEvent.click(await afterPause("Подтвердить закрытие"));
      expect(
        await screen.findByText(
          "Смена закрыта на этой станции. Данные будут отправлены автоматически.",
        ),
      ).toBeTruthy();
      const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
      const unsent = () => within(bar).getByText("Не отправлено").nextElementSibling?.textContent;
      await waitFor(() => expect(unsent()).toBe("5"));
      fireEvent.click(await afterPause("К списку смен"));
      expect(await screen.findByRole("button", { name: "Закрывается" })).toBeTruthy();
      host.sendFacts.mockImplementation(async (records) =>
        records.map((record) => ({
          id: (record as { id: string }).id,
          outcome: "accepted" as const,
        })),
      );
      await link.status({ ...ONLINE, seq: 3 });
      await waitFor(() => expect(unsent()).toBe("0"));
      const delivered = host.sendFacts.mock.calls.at(-1)?.[0] ?? [];
      expect(delivered.map((record) => (record as { kind: string }).kind)).toEqual([
        "scan",
        "scan",
        "box_closed",
        "box_label",
        "shift_closed",
      ]);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Закрывается" })).toBeNull());
    } finally {
      clock.mockRestore();
    }
  });

  it("deletes at its start the records of a shift whose close the host took 30 days ago", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(
      executor,
      { hostId: HOST_ID, deviceId: DEVICE_ID },
      OPENED,
      "2026-10-09T06:00:00.000Z",
      1,
    );
    const ackedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE floor_shifts SET local_state = 'closed'").run();
    const insert = db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
        "outcome, acked_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)",
    );
    insert.run(
      crypto.randomUUID(),
      HOST_ID,
      DEVICE_ID,
      "scan",
      OPENED.id,
      ackedAt,
      "rejected",
      ackedAt,
    );
    insert.run(
      crypto.randomUUID(),
      HOST_ID,
      DEVICE_ID,
      "shift_closed",
      OPENED.id,
      ackedAt,
      "accepted",
      ackedAt,
    );
    // The purge waits until the status bar has counted the refused record, so that the bar's
    // new count can only come from the app being told the outbox changed.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: LocalExecutor = {
      query: (sql, params, row) => executor.query(sql, params, row),
      transaction: async (statements) => {
        if (statements[0]?.sql.startsWith("DELETE FROM floor_shifts")) await gate;
        return executor.transaction(statements);
      },
    };
    const refused = () => screen.queryByText("Отклонено хостом")?.nextElementSibling?.textContent;
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      local: gated,
    });
    await waitFor(() => expect(refused()).toBe("1"));
    release();
    await waitFor(() =>
      expect({ ...db.prepare("SELECT count(*) AS n FROM floor_shifts").get() }).toEqual({ n: 0 }),
    );
    expect({ ...db.prepare("SELECT count(*) AS n FROM outbox").get() }).toEqual({ n: 0 });
    // The list and the bar read their copies again: the purge counts as a change of the outbox.
    await waitFor(() => expect(refused() ?? "0").toBe("0"));
  });

  it("does not tell the app the outbox changed when the pass deleted nothing", async () => {
    const { executor } = openLocalDb();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let counts = 0;
    let passes = 0;
    // The pass waits until the status bar has made its first count of the unsent records.
    const watching: LocalExecutor = {
      query: async (sql, params, row) => {
        if (sql.includes("FROM floor_shifts s")) {
          await gate;
          const rows = await executor.query(sql, params, row);
          passes += 1;
          return rows;
        }
        if (sql === UNSENT_COUNT_SQL) counts += 1;
        return executor.query(sql, params, row);
      },
      transaction: (statements) => executor.transaction(statements),
    };
    const host = fakeHost();
    host.getChanges.mockResolvedValueOnce(feedPage(42, PEOPLE));
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      local: watching,
    });
    await screen.findByText(PROMPT);
    await waitFor(() => expect(counts).toBeGreaterThan(0));
    await flush();
    const before = counts;
    release();
    await waitFor(() => expect(passes).toBe(1));
    await flush();
    expect(counts).toBe(before);
  });

  it("runs no retention pass for a computer that is not paired", async () => {
    const { executor } = openLocalDb();
    const asked: string[] = [];
    const watching: LocalExecutor = {
      query: (sql, params, row) => {
        asked.push(sql);
        return executor.query(sql, params, row);
      },
      transaction: (statements) => executor.transaction(statements),
    };
    renderApp({
      probe: probeAnswering(false),
      device: fakeDevice(null),
      host: fakeHost(),
      local: watching,
    });
    await screen.findByText("Первый запуск");
    await flush();
    expect(asked.filter((sql) => sql.includes("FROM floor_shifts s"))).toEqual([]);
  });

  it("repeats its retention pass every hour while the app is open and stops it when the app goes", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    try {
      const view = renderApp({
        probe: probeAnswering(true),
        device: fakeDevice(DEVICE_STATUS),
        host: fakeHost(),
      });
      await waitFor(() =>
        expect(set.mock.calls.filter(([, ms]) => ms === 3_600_000).length).toBeGreaterThan(0),
      );
      const hourly = set.mock.results
        .filter((_, index) => set.mock.calls[index]?.[1] === 3_600_000)
        .map((result) => result.value as unknown);
      view.unmount();
      for (const timer of hourly) expect(cleared.mock.calls.map(([id]) => id)).toContain(timer);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });
});

/**
 * Kiosk mode as a built app has it (`dev: false`), with the shell's commands
 * recorded instead of sent; a command in `failing` refuses.
 */
function recordingLockdown() {
  const commands: LockdownCommand[] = [];
  const failing = new Set<LockdownCommand>();
  const lockdown = createLockdownLifecycle({
    dev: false,
    invoke: async (command) => {
      commands.push(command);
      if (failing.has(command)) throw "window_failed";
    },
    logError: () => undefined,
  });
  return { lockdown, commands, failing };
}

/** «Оконный режим» from the office header, confirmed in its dialog. */
async function leaveKioskMode(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
  expect(await screen.findByText("Перейти в оконный режим?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
}

describe("kiosk mode", () => {
  it("locks the window once at start, under StrictMode too, and keeps it locked through the office", async () => {
    const kiosk = recordingLockdown();
    render(
      <StrictMode>
        <ThemeProvider defaultTheme="dark">
          <App
            probe={probeAnswering(true)}
            device={fakeDevice(DEVICE_STATUS)}
            host={fakeHost()}
            connection={fakeConnection().connection}
            local={openLocalDb().executor}
            address={ADDRESS}
            lockdown={kiosk.lockdown}
          />
        </ThemeProvider>
      </StrictMode>,
    );
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));

    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    // Already locked: neither the office nor the way back sends anything.
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
  });

  it("tries a lock that failed again when the office closes", async () => {
    const kiosk = recordingLockdown();
    kiosk.failing.add("enter_lockdown");
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown: kiosk.lockdown,
    });
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
    kiosk.failing.clear();

    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "enter_lockdown"]));
  });

  it("sends no kiosk command in development, where the window stays ordinary", async () => {
    const invoke = vi.fn(async () => undefined);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown: createLockdownLifecycle({ dev: true, invoke }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets the administrator out in the office and locks the window again on leaving", async () => {
    const kiosk = recordingLockdown();
    const host = fakeHost();
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await leaveKioskMode();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown"]));
    expect(host.officeMe).toHaveBeenCalledWith("office-session-token");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() =>
      expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown", "enter_lockdown"]),
    );
  });

  it("locks the window again when the office session ends while it is windowed", async () => {
    const kiosk = recordingLockdown();
    const host = fakeHost();
    host.officeMe.mockResolvedValue(SESSION.user);
    host.officeChangePassword.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "office session ended",
        details: { credential: "session" },
      }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await leaveKioskMode();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown"]));

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
    expect(await screen.findByText("Сессия офиса закончилась. Войдите снова.")).toBeTruthy();
    await waitFor(() =>
      expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown", "enter_lockdown"]),
    );
  });

  it("offers no way out to a technologist", async () => {
    const kiosk = recordingLockdown();
    const host = fakeHost();
    host.officeLogin.mockResolvedValue({
      ...SESSION,
      user: { ...SESSION.user, login: "tech", name: "Павел Орлов", role: "technologist" },
    });
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Павел Орлов.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
  });

  it("offers no way out where the build does not lock the window at all", async () => {
    // A lifecycle that reports `enabled: false` (development) but, as a fault
    // would have it, calls the window locked: the guard is `enabled`, not the mode.
    const snapshot = { mode: "locked", pending: false, error: null } as const;
    const lockdown = {
      ...recordingLockdown().lockdown,
      enabled: false,
      getSnapshot: () => snapshot,
    };
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
  });

  it("keeps the dialog open and says so when the window does not leave kiosk mode", async () => {
    const kiosk = recordingLockdown();
    kiosk.failing.add("exit_lockdown");
    const host = fakeHost();
    host.officeMe.mockResolvedValue(SESSION.user);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      lockdown: kiosk.lockdown,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    await signIn();
    await leaveKioskMode();
    expect(
      await screen.findByText("Окно не вышло из киоск-режима. Попробуйте ещё раз."),
    ).toBeTruthy();
    expect(screen.getByText("Перейти в оконный режим?")).toBeTruthy();
    // The failed exit may have changed some properties: «Выйти в цех» locks again.
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Выйти в цех" }));
    await waitFor(() =>
      expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown", "enter_lockdown"]),
    );
  });
});

describe("useHostLink", () => {
  it("starts the link and a sync over when the pairing changes its device id under the same host", async () => {
    const { db, executor } = openLocalDb();
    const link = fakeConnection();
    const changes = vi.fn(async () => feedPage(10, [lineItem(10, "Линия 1")]));
    const refresh = vi.fn(async () => DEVICE_STATUS);
    // One function for every render: a new one would restart the link by itself.
    const dispatch = vi.fn();
    const otherDeviceId = "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f";
    // `device_id` is stamped before the first fetch, `last_rev` only when the
    // page lands: both there means a run finished for that pairing.
    const syncState = () =>
      Object.fromEntries(
        db
          .prepare("SELECT key, value FROM sync_state WHERE key IN ('device_id', 'last_rev')")
          .all()
          .map((row) => [row["key"], row["value"]]),
      );
    const { rerender, unmount } = renderHook(
      ({ deviceId }) =>
        useHostLink({
          hostId: HOST_ID,
          deviceId,
          connection: link.connection,
          local: executor,
          changes,
          refresh,
          deviceShifts: async () => [],
          sendFacts: async () => [],
          registerKnownBlocks: async () => ({ results: [] }),
          dispatch,
        }),
      { initialProps: { deviceId: DEVICE_ID } },
    );
    await waitFor(() => expect(syncState()).toEqual({ device_id: DEVICE_ID, last_rev: "10" }));
    expect(link.connection.watch).toHaveBeenCalledTimes(1);

    // A new pairing with the same host: the host gave it another device id,
    // so the old run stops, the copies are wiped and read again in full.
    rerender({ deviceId: otherDeviceId });
    await waitFor(() => expect(syncState()).toEqual({ device_id: otherDeviceId, last_rev: "10" }));
    expect(link.stop).toHaveBeenCalledTimes(1);
    expect(link.connection.watch).toHaveBeenCalledTimes(2);
    expect(changes.mock.calls).toEqual([[0], [0]]);
    unmount();
  });
});

describe("the outbox in the app", () => {
  it("goes to the host once the station is linked, and each record keeps the host's answer", async () => {
    const database = openLocalDb();
    const [first, second] = await unsentScans(database.executor, 2);
    const link = fakeConnection();
    const host = fakeHost();
    host.sendFacts.mockImplementation(async (records) => [
      { id: (records[0] as { id: string }).id, outcome: "accepted" },
      { id: (records[1] as { id: string }).id, outcome: "rejected", code: "unknown_shift" },
    ]);
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: database.executor,
    });
    await waitFor(() =>
      expect(
        rows(database.db, "SELECT id, outcome, outcome_code FROM outbox ORDER BY seq"),
      ).toEqual([
        { id: first, outcome: "accepted", outcome_code: null },
        { id: second, outcome: "rejected", outcome_code: "unknown_shift" },
      ]),
    );
    expect(host.sendFacts).toHaveBeenCalledTimes(1);
  });

  /** The value the floor's status bar shows under `label`, or `null` when it shows no such item. */
  function barValue(label: string): string | null {
    const term = screen.queryByText(label);
    return term === null ? null : (term.nextElementSibling?.textContent ?? null);
  }

  it("shows the floor's status bar what waits, what the host refused and what conflicts, as the host answers", async () => {
    const database = openLocalDb();
    const [first, second, third] = await unsentScans(database.executor, 3);
    const link = fakeConnection();
    const host = fakeHost();
    host.sendFacts.mockImplementation(async (records) => {
      expect(records.map((record) => (record as { id: string }).id)).toEqual([
        first,
        second,
        third,
      ]);
      return [
        { id: first ?? "", outcome: "accepted" },
        { id: second ?? "", outcome: "rejected", code: "unknown_shift" },
        { id: third ?? "", outcome: "conflict", code: "code_taken" },
      ];
    });
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: database.executor,
    });
    await waitFor(() => expect(barValue("Отклонено хостом")).toBe("1"));
    expect(barValue("Конфликтов")).toBe("1");
    expect(barValue("Не отправлено")).toBe("0");
  });

  it("tells the floor's status bar when the host fails the delivery, and how long the record has waited", async () => {
    const database = openLocalDb();
    await unsentScans(database.executor, 2);
    const link = fakeConnection();
    const host = fakeHost();
    host.sendFacts.mockRejectedValue(
      new HostError({ kind: "api", code: "internal_error", status: 500, message: "boom" }),
    );
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host,
      connection: link.connection,
      local: database.executor,
    });
    expect(await screen.findByText(/Хост не принимает записи смены/)).toBeTruthy();
    expect(await screen.findByText(/Самая старая запись ждёт отправки уже/)).toBeTruthy();
    expect(barValue("Не отправлено")).toBe("2");
  });
});

describe("an office PC and the host's address (plan УСТ)", () => {
  /** An office PC paired with the host on the station PC. */
  const OFFICE_PC: DeviceStatus = {
    ...DEVICE_STATUS,
    hostAddress: REMOTE_ADDRESS,
    kind: "office",
    lineId: null,
  };

  function officePc() {
    const device = fakeDevice(OFFICE_PC);
    device.installRole.mockResolvedValue("office");
    return device;
  }

  it("never locks an office PC, opens on the office sign-in and comes back to it", async () => {
    const kiosk = recordingLockdown();
    const device = officePc();
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), lockdown: kiosk.lockdown });
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "В цех" })).toBeNull();
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Выйти в цех" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Цех")).toBeNull();
    expect(device.installRole).toHaveBeenCalled();
    expect(kiosk.commands).toEqual([]);
  });

  it("still locks a station when the shell reports no role", async () => {
    const kiosk = recordingLockdown();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown: kiosk.lockdown,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });

  it("locks a station whose role the shell could not tell", async () => {
    const kiosk = recordingLockdown();
    const device = fakeDevice(DEVICE_STATUS);
    device.installRole.mockRejectedValue(new DeviceError("invalid_response", "role"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), lockdown: kiosk.lockdown });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });

  it("moves the pairing to the host's new address from the office sign-in", async () => {
    const device = officePc();
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText(`Хост: ${REMOTE_ADDRESS}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сменить адрес хоста" }));
    fireEvent.change(await screen.findByLabelText("Адрес хоста"), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText("Адрес хоста изменён: https://192.168.1.20:45710."),
    ).toBeTruthy();
    expect(device.changeAddress).toHaveBeenCalledWith("https://192.168.1.20:45710");
    expect(screen.getByText("Хост: https://192.168.1.20:45710")).toBeTruthy();
    expect(screen.queryByText("Новый адрес хоста")).toBeNull();
  });

  it("keeps the dialog open and explains an address that is not the paired host or answers nothing", async () => {
    const device = officePc();
    device.changeAddress.mockRejectedValueOnce(
      new DeviceError("address_other_host", "another certificate"),
    );
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Сменить адрес хоста" }));
    const field = await screen.findByLabelText("Адрес хоста");
    fireEvent.change(field, { target: { value: "адрес хоста" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "Введите IP-адрес или имя ПК хоста, при необходимости с портом через двоеточие.",
      ),
    ).toBeTruthy();
    expect(device.changeAddress).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "192.168.1.30" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "По этому адресу отвечает другой хост: его сертификат не совпадает с сохранённым при подключении. Проверьте адрес на ПК хоста.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Новый адрес хоста")).toBeTruthy();
    expect(screen.getByText(`Хост: ${REMOTE_ADDRESS}`)).toBeTruthy();

    // Nothing answers there: about the address, not about this computer's service.
    device.changeAddress.mockRejectedValueOnce(new DeviceError("unreachable", "no answer"));
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "По этому адресу хост не отвечает. Проверьте адрес, сеть и что ПК хоста включён.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Служба хоста на этом компьютере не отвечает.")).toBeNull();
  });

  it("treats a key the host no longer accepts at the new address as a rejected device", async () => {
    const device = officePc();
    device.changeAddress.mockRejectedValueOnce(new DeviceError("key_rejected", "revoked"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Сменить адрес хоста" }));
    fireEvent.change(await screen.findByLabelText("Адрес хоста"), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("offers no address change for the host on this computer", async () => {
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сменить адрес хоста" })).toBeNull();
    expect(screen.getByRole("button", { name: "В цех" })).toBeTruthy();
  });

  it("keeps the window unlocked until the shell has named the role, then locks a station", async () => {
    const kiosk = recordingLockdown();
    const device = fakeDevice(DEVICE_STATUS);
    let answer: (role: "station") => void = () => undefined;
    device.installRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), lockdown: kiosk.lockdown });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(device.installRole).toHaveBeenCalled());
    expect(kiosk.commands).toEqual([]);
    act(() => answer("station"));
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });

  it.each(["host", "station"] as const)(
    "keeps a %s PC locked even when its disk holds an office pairing",
    async (role) => {
      const kiosk = recordingLockdown();
      const device = fakeDevice(OFFICE_PC);
      device.installRole.mockResolvedValue(role);
      renderApp({
        probe: probeAnswering(true),
        device,
        host: fakeHost(),
        lockdown: kiosk.lockdown,
      });
      await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
    },
  );

  it("shows no floor on an office PC whose disk holds a station pairing", async () => {
    const kiosk = recordingLockdown();
    const device = fakeDevice(DEVICE_STATUS);
    device.installRole.mockResolvedValue("office");
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), lockdown: kiosk.lockdown });
    // Never the operator's sign-in, the line choice or the station's bar.
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Цех")).toBeNull();
    expect(screen.queryByRole("button", { name: "В цех" })).toBeNull();
    await signIn();
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Цех")).toBeNull();
    expect(kiosk.commands).toEqual([]);
  });

  it("shows no line choice on an office PC either", async () => {
    const device = fakeDevice({ ...DEVICE_STATUS, lineId: null });
    device.installRole.mockResolvedValue("office");
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Выбор линии")).toBeNull();
  });

  it("gives a station PC paired with a remote host «В цех» and «Выйти в цех», and the address change", async () => {
    const device = fakeDevice({ ...DEVICE_STATUS, hostAddress: REMOTE_ADDRESS });
    device.installRole.mockResolvedValue("station");
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    expect(await screen.findByText(`Хост: ${REMOTE_ADDRESS}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сменить адрес хоста" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "В цех" })).toBeTruthy();
    await signIn();
    expect(await screen.findByRole("button", { name: "Выйти в цех" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull();
  });

  it("tells a malformed address the shell refused in plain words, not as a broken app", async () => {
    const device = officePc();
    device.changeAddress.mockRejectedValueOnce(new DeviceError("invalid_request", "bad address"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Сменить адрес хоста" }));
    fireEvent.change(await screen.findByLabelText("Адрес хоста"), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "Введите IP-адрес или имя ПК хоста, при необходимости с портом через двоеточие.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Приложение сформировало недопустимый запрос.")).toBeNull();
    expect(screen.getByText("Новый адрес хоста")).toBeTruthy();
  });

  it("clears the earlier complaint with the next try, and opens the dialog empty again", async () => {
    const device = officePc();
    device.changeAddress.mockRejectedValueOnce(new DeviceError("unreachable", "no answer"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    const open = await screen.findByRole("button", { name: "Сменить адрес хоста" });
    fireEvent.click(open);
    const field = await screen.findByLabelText("Адрес хоста");
    fireEvent.change(field, { target: { value: "192.168.1.20" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    const unreachable =
      "По этому адресу хост не отвечает. Проверьте адрес, сеть и что ПК хоста включён.";
    expect(await screen.findByText(unreachable)).toBeTruthy();

    // A new try that cannot be sent takes the old answer off the screen.
    fireEvent.change(field, { target: { value: "адрес хоста" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    const invalid =
      "Введите IP-адрес или имя ПК хоста, при необходимости с портом через двоеточие.";
    expect(await screen.findByText(invalid)).toBeTruthy();
    expect(screen.queryByText(unreachable)).toBeNull();

    // An address that can be sent takes the complaint about the spelling off,
    // whatever the host then answers.
    device.changeAddress.mockRejectedValueOnce(new DeviceError("address_other_host", "other"));
    fireEvent.change(field, { target: { value: "192.168.1.21" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(await screen.findByText(/отвечает другой хост/)).toBeTruthy();
    expect(screen.queryByText(invalid)).toBeNull();

    fireEvent.change(field, { target: { value: "192.168.1.20" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText("Адрес хоста изменён: https://192.168.1.20:45710."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Сменить адрес хоста" }));
    expect((await screen.findByLabelText<HTMLInputElement>("Адрес хоста")).value).toBe("");
  });

  it("announces the new address in a live region and gives the focus back to its button", async () => {
    const device = officePc();
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    const open = await screen.findByRole("button", { name: "Сменить адрес хоста" });
    open.focus();
    fireEvent.click(open);
    fireEvent.change(await screen.findByLabelText("Адрес хоста"), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    const done = await screen.findByText("Адрес хоста изменён: https://192.168.1.20:45710.");
    // The region was there before the text came, and the alert does not shout twice.
    expect(done.closest("[aria-live='polite']")).not.toBeNull();
    expect(done.closest("[role='presentation']")).not.toBeNull();
    expect(done.closest("[role='alert']")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("closes the dialog on «Отмена» and changes nothing", async () => {
    const device = officePc();
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    const open = await screen.findByRole("button", { name: "Сменить адрес хоста" });
    open.focus();
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText("Новый адрес хоста")).toBeNull());
    expect(device.changeAddress).not.toHaveBeenCalled();
    expect(screen.getByText(`Хост: ${REMOTE_ADDRESS}`)).toBeTruthy();
    expect(document.activeElement).toBe(open);
  });
});
