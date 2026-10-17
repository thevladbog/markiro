import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { App } from "../src/app/App.js";
import type { FullscreenController } from "../src/app/fullscreen.js";
import type { KioskPolicyApi } from "../src/app/kiosk-policy.js";
import {
  createLockdownLifecycle,
  type LockdownCommand,
  type LockdownSnapshot,
} from "../src/app/lockdown.js";
import type { HardwareApi } from "../src/hardware/hardware.js";
import type { HostApi } from "../src/host/api.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import { DeviceError, type DeviceApi, type InstallRole } from "../src/host/device.js";
import { HostProbeError, type HostProbe } from "../src/host/probe.js";
import type { DeviceStatus, HostStatus } from "../src/host/protocol.js";
import { DEVICE_STATUS, LINE_ID, NEW_STATION, observation, SESSION } from "./support/fixtures.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeHostApi } from "./support/office.js";
import { chooseFromUserMenu } from "./support/user-menu.js";

/**
 * Owner feedback from the first Windows test of a station PC: the app opened
 * locked on the pairing screen, a COM scanner could neither be set up nor
 * read the office's code there, and nothing led to a normal window. Owner
 * decision 2026-10-13: a host PC never locks, a station is an ordinary window
 * until it is configured (paired as a station with a line) and locks from
 * then on.
 */

const ADDRESS = "https://127.0.0.1:45710";
const FINGERPRINT = "ab".repeat(32);
const PAYLOAD = `markiro-host:1?h=192.168.1.10&p=45710&f=${FINGERPRINT}&c=7K3MQ9XV2D`;
const ONLINE: HostStatus = {
  state: "online",
  lastContactAt: 1_790_000_000_000,
  lastError: null,
  seq: 1,
};

/** No host on this PC; the one on 192.168.1.10 answers with the payload's certificate. */
function lanProbe(): HostProbe {
  return {
    hello: vi.fn<HostProbe["hello"]>(async (address) => {
      if (address !== "https://192.168.1.10:45710") throw new HostProbeError("unreachable", "down");
      return observation(true);
    }),
  };
}

/**
 * The shell's device: `claim` pairs as a station without a line; `lineFromHost`
 * is what a read of the device then finds (the office's line, or none).
 */
function fakeDevice(initial: DeviceStatus | null, role: InstallRole) {
  let paired = initial;
  let lineFromHost: string | null = initial?.lineId ?? null;
  const device: DeviceApi = {
    status: vi.fn<DeviceApi["status"]>(async () => paired),
    pairLocally: vi.fn<DeviceApi["pairLocally"]>(async () => {
      throw new DeviceError("unreachable", "no host here");
    }),
    claim: vi.fn<DeviceApi["claim"]>(async ({ address, fingerprint }) => {
      paired = { ...NEW_STATION, hostAddress: address, fingerprint };
      return paired;
    }),
    selectLine: vi.fn<DeviceApi["selectLine"]>(async () => {
      throw new DeviceError("not_paired", "not paired");
    }),
    forget: vi.fn<DeviceApi["forget"]>(async () => {
      paired = null;
    }),
    refresh: vi.fn<DeviceApi["refresh"]>(async () => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      paired = { ...paired, lineId: lineFromHost };
      return paired;
    }),
    installRole: vi.fn<DeviceApi["installRole"]>(async () => role),
    changeAddress: vi.fn<DeviceApi["changeAddress"]>(async () => {
      throw new DeviceError("not_paired", "not paired");
    }),
  };
  return {
    device,
    setLineFromHost: (lineId: string | null) => {
      lineFromHost = lineId;
    },
  };
}

/** The link: online at once; `revision` reaches the app like a shell event. */
function fakeConnection() {
  let handlers: ConnectionHandlers | null = null;
  const connection: ConnectionApi = {
    watch: vi.fn<ConnectionApi["watch"]>(async (next) => {
      handlers = next;
      next.onStatus(ONLINE);
      return () => {
        handlers = null;
      };
    }),
  };
  return {
    connection,
    revision: async (rev: number) => {
      await waitFor(() => expect(handlers).not.toBeNull());
      await act(async () => {
        handlers?.onRevision(rev);
      });
    },
  };
}

/** The shell's COM scanners: `emit` hands one frame to every subscriber. */
function comHardware() {
  const shell = fakeHardware();
  const listeners = new Set<(raw: string) => void>();
  const hardware: HardwareApi = {
    ...shell.hardware,
    onScan: vi.fn<HardwareApi["onScan"]>(async (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  return {
    hardware,
    emit: (raw: string) => {
      act(() => {
        for (const listener of [...listeners]) listener(raw);
      });
    },
  };
}

/** The webview's full-screen window as a controller that records what it was asked. */
function fakeFullscreen({ enabled = true }: { enabled?: boolean } = {}) {
  let snapshot: LockdownSnapshot = { mode: "windowed", pending: false, error: null };
  const listeners = new Set<() => void>();
  const set = (mode: LockdownSnapshot["mode"]) => {
    snapshot = { mode, pending: false, error: null };
    listeners.forEach((listener) => listener());
  };
  return {
    enabled,
    enter: vi.fn(async () => set("locked")),
    exit: vi.fn(async () => {
      if (snapshot.mode === "locked") set("windowed");
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    clearError: vi.fn(),
  } satisfies FullscreenController;
}

/** What the shell permits; `turnOff` is a second launch with `--windowed`. */
function fakeKioskPolicy(permitted = true) {
  let turnedOff: (() => void) | null = null;
  const policy: KioskPolicyApi = {
    permitted: vi.fn(async () => permitted),
    onTurnedOff: vi.fn(async (listener: () => void) => {
      turnedOff = listener;
      return () => {
        turnedOff = null;
      };
    }),
  };
  return {
    policy,
    turnOff: () => {
      act(() => turnedOff?.());
    },
  };
}

function recordingLockdown() {
  const commands: LockdownCommand[] = [];
  const lockdown = createLockdownLifecycle({
    dev: false,
    invoke: async (command) => {
      commands.push(command);
    },
    logError: () => undefined,
  });
  return { lockdown, commands };
}

function renderStation({
  status = null,
  role = "station",
  permitted = true,
  host = fakeHostApi({
    officeLogin: vi.fn<HostApi["officeLogin"]>(async () => SESSION),
  }),
  fullscreen,
}: {
  status?: DeviceStatus | null;
  role?: InstallRole;
  permitted?: boolean;
  host?: HostApi;
  fullscreen?: FullscreenController;
} = {}) {
  const kiosk = recordingLockdown();
  const com = comHardware();
  const device = fakeDevice(status, role);
  const link = fakeConnection();
  const shell = fakeKioskPolicy(permitted);
  render(
    <ThemeProvider defaultTheme="dark">
      <App
        probe={lanProbe()}
        device={device.device}
        host={host}
        connection={link.connection}
        local={openLocalDb().executor}
        address={ADDRESS}
        hardware={com.hardware}
        lockdown={kiosk.lockdown}
        kioskPolicy={shell.policy}
        {...(fullscreen === undefined ? {} : { fullscreen })}
      />
    </ThemeProvider>,
  );
  return { kiosk, com, device, link, shell };
}

async function openNetworkPairing(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Подключиться к хосту в сети" }));
  await screen.findByRole("heading", { name: "Подключение к хосту в сети" });
}

/** Lets pending effects and answers settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function signIn(): Promise<void> {
  await screen.findByText("Вход в офис");
  fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Войти" }));
  await screen.findByRole("heading", { name: "Обзор", level: 1 });
}

async function signInToOffice(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
  await signIn();
}

describe("a station PC before its configuration", () => {
  it("stays an ordinary window on «host not answering», the pairing and the scanner settings", async () => {
    const { kiosk } = renderStation();
    await openNetworkPairing();
    fireEvent.click(screen.getByRole("button", { name: "Настройки сканера" }));
    expect(await screen.findByRole("heading", { name: "Настройки сканера" })).toBeTruthy();
    await settle();
    expect(kiosk.commands).toEqual([]);
  });

  it("opens the scanner settings from the pairing screen and comes back to it", async () => {
    renderStation();
    await openNetworkPairing();
    fireEvent.click(screen.getByRole("button", { name: "Настройки сканера" }));
    expect(await screen.findByRole("heading", { name: "Настройки сканера" })).toBeTruthy();
    expect(screen.getByLabelText("COM-порт")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByLabelText("Код с экрана офиса")).toBeTruthy();
    // Typing the code by hand stays open.
    expect(screen.getByRole("button", { name: "Ввести адрес и код вручную" })).toBeTruthy();
  });

  it("pairs with the office's code a COM scanner sent, and stays windowed without a line", async () => {
    const { com, device, kiosk } = renderStation();
    await openNetworkPairing();
    com.emit(PAYLOAD);
    await waitFor(() =>
      expect(device.device.claim).toHaveBeenCalledWith({
        address: "https://192.168.1.10:45710",
        fingerprint: FINGERPRINT,
        code: "7K3MQ9XV2D",
        name: "Станция",
      }),
    );
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
    await settle();
    expect(kiosk.commands).toEqual([]);
  });

  it("locks the window once the office gives the paired station its line", async () => {
    const { com, device, kiosk, link } = renderStation();
    await openNetworkPairing();
    com.emit(PAYLOAD);
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
    expect(kiosk.commands).toEqual([]);
    device.setLineFromHost(LINE_ID);
    await link.revision(2);
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });
});

describe("a configured station", () => {
  it("locks at start", async () => {
    const { kiosk } = renderStation({ status: DEVICE_STATUS });
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });

  it("stays locked when the office clears its line later", async () => {
    const { kiosk, device, link } = renderStation({ status: DEVICE_STATUS });
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
    device.setLineFromHost(null);
    await link.revision(2);
    expect(await screen.findByText("Выбор линии")).toBeTruthy();
    await settle();
    expect(kiosk.commands).toEqual(["enter_lockdown"]);
  });

  it("stays an ordinary window where the shell forbids kiosk mode (`kiosk: false`, `--windowed`)", async () => {
    const { kiosk } = renderStation({ status: DEVICE_STATUS, permitted: false });
    expect(await screen.findByText("Вход оператора")).toBeTruthy();
    await settle();
    expect(kiosk.commands).toEqual([]);
  });

  it("leaves kiosk mode when a second launch with `--windowed` turns it off", async () => {
    const { kiosk, shell } = renderStation({ status: DEVICE_STATUS });
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
    shell.turnOff();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown", "exit_lockdown"]));
  });
});

describe("the host's PC", () => {
  // Owner requirement (beta 3.2): the host's PC starts in the office, and the
  // floor on this PC is one «В цех» away; it replaced «starts on the floor».
  it("never locks: not in the office, not on the floor, not on leaving it", async () => {
    const { kiosk } = renderStation({ status: DEVICE_STATUS, role: "host" });
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Вход оператора")).toBeNull();
    await signIn();
    await chooseFromUserMenu("Выйти из офиса");
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "В цех" }));
    expect(await screen.findByText("Вход оператора")).toBeTruthy();
    // The floor asks for the office again, and a floor left once stays left.
    await signInToOffice();
    await settle();
    expect(kiosk.commands).toEqual([]);
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
  });

  // Owner report (beta 4.5): «на хосте решил зайти в цех — нет кнопки полноэкранного
  // режима». The kiosk (locking) mode stays off for this PC (decision 2026-10-13); the
  // floor's rail offers the plain full-screen window instead, with the way out one press away.
  it("offers the plain full-screen window on the floor, never the locking kiosk mode", async () => {
    const fullscreen = fakeFullscreen();
    const { kiosk } = renderStation({ status: DEVICE_STATUS, role: "host", fullscreen });
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    expect(await screen.findByText("Вход оператора")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Полноэкранный режим" }));
    await waitFor(() => expect(fullscreen.enter).toHaveBeenCalledTimes(1));
    // Full screen, and the button now says how to leave it: no identity proof, no dialog.
    fireEvent.click(await screen.findByRole("button", { name: "Выйти из полноэкранного режима" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(fullscreen.exit).toHaveBeenCalledTimes(1));
    expect(kiosk.commands).toEqual([]);
  });

  it("leaves full screen on its own when the host goes from the floor to the office", async () => {
    const fullscreen = fakeFullscreen();
    renderStation({ status: DEVICE_STATUS, role: "host", fullscreen });
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    fireEvent.click(await screen.findByRole("button", { name: "Полноэкранный режим" }));
    await waitFor(() => expect(fullscreen.enter).toHaveBeenCalledTimes(1));
    await signInToOffice();
    await waitFor(() => expect(fullscreen.exit).toHaveBeenCalledTimes(1));
  });

  it("offers it nowhere without the webview's Fullscreen API, and not on a station", async () => {
    renderStation({
      status: DEVICE_STATUS,
      role: "host",
      fullscreen: fakeFullscreen({ enabled: false }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    expect(await screen.findByText("Вход оператора")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Полноэкранный режим" })).toBeNull();
    cleanup();
    const station = fakeFullscreen();
    renderStation({ status: DEVICE_STATUS, role: "station", fullscreen: station });
    expect(await screen.findByText("Вход оператора")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Полноэкранный режим" })).toBeNull();
    expect(station.enter).not.toHaveBeenCalled();
  });

  it("starts in the office again at the next launch, whatever the last session chose", async () => {
    const first = renderStation({ status: DEVICE_STATUS, role: "host" });
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    expect(await screen.findByText("Вход оператора")).toBeTruthy();
    cleanup();
    expect(first.kiosk.commands).toEqual([]);
    renderStation({ status: DEVICE_STATUS, role: "host" });
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Вход оператора")).toBeNull();
    cleanup();
  });

  it("never locks before its pairing either", async () => {
    const { kiosk } = renderStation({ role: "host" });
    await screen.findByRole("button", { name: "Подключиться к хосту в сети" });
    await settle();
    expect(kiosk.commands).toEqual([]);
    cleanup();
  });
});
