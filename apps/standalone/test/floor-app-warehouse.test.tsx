import { readFileSync } from "node:fs";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, FloorSession, ShellAction, SyncState } from "../src/app/shell.js";
import { FloorApp } from "../src/floor/FloorApp.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanSource } from "../src/floor/scan-source.js";
import { replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import type { WarehouseScreenProps } from "../src/floor/warehouse/WarehouseScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import { HostError } from "../src/host/client.js";
import {
  deviceShiftsSchema,
  type ChangeItem,
  type ChangesResponse,
  type DeviceShift,
  type HostStatus,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";

// The warehouse screen is Task 7's and has its own suites; the floor's wiring of it
// (the entry, the gate, the leave, the setup and back) is what this file proves.
const screens = vi.hoisted(() => ({
  seen: [] as unknown[],
  mounts: 0,
  unmounts: 0,
}));
vi.mock("../src/floor/warehouse/WarehouseScreen.js", () => ({
  WarehouseScreen: (props: WarehouseScreenProps) => {
    screens.seen.push(props);
    return <StubWarehouse {...props} />;
  },
}));

let releaseWork: () => void = () => undefined;
let failWork: () => void = () => undefined;

function StubWarehouse(props: WarehouseScreenProps) {
  const { track } = props;
  useEffect(() => {
    screens.mounts += 1;
    return () => {
      screens.unmounts += 1;
    };
  }, []);
  useEffect(() => {
    void track(
      new Promise<void>((resolve, reject) => {
        releaseWork = resolve;
        failWork = () => reject(new Error("disk"));
      }),
    ).catch(() => undefined);
  }, [track]);
  return (
    <div>
      <p>Склад (заглушка)</p>
      <p>{props.online ? "связь есть" : "связи нет"}</p>
      <button type="button" onClick={props.onLeave}>
        К сменам
      </button>
      <button type="button" onClick={props.onSetup}>
        Рабочее место
      </button>
      <button type="button" onClick={props.touch}>
        Касание
      </button>
    </div>
  );
}

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const ANNA = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
};
const SESSION: FloorSession = { ...ANNA, sessionId: 1 };
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const OPERATOR: ChangeItem = {
  entity: "operators",
  id: ANNA.id,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: ANNA.name, role: ANNA.role, pinPhc: PIN_PHC },
};
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const [, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const SEEN = 1_790_000_000_000;
const REPRINT = "Повторная печать этикеток";
const SILENT_SOURCE: ScanSource = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

async function copies(items: ChangeItem[] = [OPERATOR]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () =>
      ({
        hostId: HOST_ID,
        rev: 10,
        hasMore: false,
        items,
      }) satisfies ChangesResponse,
    local: executor,
    ...PAIRING,
  });
  await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
  return executor;
}

function handlersOf() {
  return {
    lookup: vi.fn(async (_lookup: WarehouseLookup): Promise<WarehouseLookupResult> => ({
      status: "not_found",
    })),
    requestFacts: vi.fn(),
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    hardware: fakeHardware().hardware,
    awake: createSystemAwake(vi.fn(async () => undefined)),
    dispatch: vi.fn<(action: ShellAction) => void>(),
    onSignOut: vi.fn<(notice: FloorNotice | null) => void>(),
  };
}

interface Options {
  link?: HostStatus | null;
  sync?: SyncState;
  rejectionPending?: boolean;
  lineChangePending?: boolean;
  idleTimeoutMs?: number;
}

function floorOf(
  local: LocalExecutor,
  handlers: ReturnType<typeof handlersOf>,
  options: Options = {},
) {
  return (
    <ThemeProvider>
      <FloorApp
        operator={SESSION}
        local={local}
        device={DEVICE_STATUS}
        link={options.link === undefined ? ONLINE : options.link}
        sync={options.sync ?? SYNCED}
        shiftReads={{ done: 1, failed: false }}
        lineChangePending={options.lineChangePending ?? false}
        rejectionPending={options.rejectionPending ?? false}
        enter={vi.fn()}
        create={vi.fn()}
        checkCode={vi.fn()}
        requestBlock={vi.fn()}
        warehouseLookup={handlers.lookup}
        requestFacts={handlers.requestFacts}
        source={SILENT_SOURCE}
        printing={handlers.printing}
        hardware={handlers.hardware}
        awake={handlers.awake}
        {...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs })}
        dispatch={handlers.dispatch}
        onSignOut={handlers.onSignOut}
      />
    </ThemeProvider>
  );
}

function types(handlers: ReturnType<typeof handlersOf>): string[] {
  return handlers.dispatch.mock.calls.map(([action]) => action.type);
}

async function inTheWarehouse(options: Options = {}) {
  const local = await copies();
  const handlers = handlersOf();
  const view = render(floorOf(local, handlers, options));
  fireEvent.click(await screen.findByRole("button", { name: REPRINT }));
  await screen.findByText("Склад (заглушка)");
  const again = (next: Options = {}) =>
    view.rerender(floorOf(local, handlers, { ...options, ...next }));
  return { local, handlers, again };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/** The setup holds a press that lands just after its view changed. */
async function pastTheSetupGuard(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

const lastProps = (): WarehouseScreenProps => {
  const props = screens.seen.at(-1);
  if (props === undefined) throw new Error("the warehouse screen was not mounted");
  return props as WarehouseScreenProps;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  screens.seen = [];
  screens.mounts = 0;
  screens.unmounts = 0;
  releaseWork = () => undefined;
  failWork = () => undefined;
});

describe("what the floor gives the warehouse reprint (plan СКЛ)", () => {
  it("gives it this pairing, the lookup of the host, the link and the floor's own services", async () => {
    const { handlers } = await inTheWarehouse();
    const props = lastProps();
    expect(props.operator).toBe(SESSION);
    expect(props.pairing).toEqual(PAIRING);
    expect(props.lookup).toBe(handlers.lookup);
    expect(props.printing).toBe(handlers.printing);
    expect(props.source).toBe(SILENT_SOURCE);
    expect(props.online).toBe(true);
    expect(props.isLeaving()).toBe(false);
    props.onRecorded();
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: "outbox_changed" });
    expect(handlers.requestFacts).toHaveBeenCalledTimes(1);
    // The reprint is no shift: the shell is told of no work.
    expect(types(handlers)).not.toContain("work_entered");
  });

  it("says offline when the link is down, and when the host refused the device", async () => {
    const down = await inTheWarehouse({ link: null });
    expect(screen.getByText("связи нет")).toBeTruthy();
    cleanup();
    await inTheWarehouse({ rejectionPending: true });
    expect(screen.getByText("связи нет")).toBeTruthy();
    expect(down.handlers.lookup).not.toHaveBeenCalled();
  });

  it("hands a refused key of the host to the shell", async () => {
    const { handlers } = await inTheWarehouse();
    lastProps().onHostError(new Error("not a host error"));
    expect(types(handlers)).not.toContain("device_rejected");
    lastProps().onHostError(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "no",
        details: { credential: "device" },
      }),
    );
    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: "device_rejected",
      reason: "key_rejected",
    });
  });

  it("starts the operator's idle wait again on a touch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { handlers } = await inTheWarehouse({ idleTimeoutMs: 30_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Касание" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    // The sign-out waits for the screen's work, so the leave it starts is what shows it fired.
    expect(lastProps().isLeaving()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(lastProps().isLeaving()).toBe(true);
    await act(async () => releaseWork());
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("idle"));
  });
});

describe("a leave from the warehouse reprint waits for its work (N9), and tells the shell of no shift", () => {
  it("waits for the work the screen tracks, says it is leaving, and then shows the list", async () => {
    const { handlers } = await inTheWarehouse();
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    await settle();
    expect(lastProps().isLeaving()).toBe(true);
    expect(screen.getByText("Склад (заглушка)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Открыть" })).toBeNull();
    await act(async () => releaseWork());
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(types(handlers)).not.toContain("work_left");
    expect(types(handlers)).not.toContain("work_entered");
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("leaves after work that failed too, and does not hold the floor", async () => {
    await inTheWarehouse();
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    await act(async () => failWork());
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
  });

  it("ends in a sign-out when one comes while the leave waits, and tells the shell of no work", async () => {
    const { local, handlers, again } = await inTheWarehouse();
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    await settle();
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 11,
        hasMore: false,
        items: [{ entity: "operators", id: ANNA.id, rev: 6, deleted: true }],
      }),
      local,
      ...PAIRING,
    });
    again({ sync: { ...SYNCED, synced: 2 } });
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    await act(async () => releaseWork());
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
    expect(types(handlers)).not.toContain("work_left");
    expect(screen.queryByRole("button", { name: "Открыть" })).toBeNull();
  });

  it("is a sign-out when the host turned the operator off while the reprint is open", async () => {
    const { local, handlers, again } = await inTheWarehouse();
    await syncReferences({
      changes: async () => ({
        hostId: HOST_ID,
        rev: 11,
        hasMore: false,
        items: [{ entity: "operators", id: ANNA.id, rev: 6, deleted: true }],
      }),
      local,
      ...PAIRING,
    });
    again({ sync: { ...SYNCED, synced: 2 } });
    await settle();
    expect(lastProps().isLeaving()).toBe(true);
    await act(async () => releaseWork());
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("is a sign-out when the idle wait runs out, after the work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { handlers } = await inTheWarehouse({ idleTimeoutMs: 30_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_500);
    });
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(lastProps().isLeaving()).toBe(true);
    await act(async () => releaseWork());
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("idle"));
    expect(types(handlers)).not.toContain("work_left");
  });

  it("enters the reprint again after a leave, taking scans again", async () => {
    await inTheWarehouse();
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    await act(async () => releaseWork());
    fireEvent.click(await screen.findByRole("button", { name: REPRINT }));
    await screen.findByText("Склад (заглушка)");
    expect(lastProps().isLeaving()).toBe(false);
    expect(screens.mounts).toBe(2);
  });
});

describe("the workstation setup from the warehouse reprint", () => {
  it("waits for the work, opens the setup, and comes back to the reprint, not the list", async () => {
    const { handlers } = await inTheWarehouse();
    fireEvent.click(screen.getByRole("button", { name: "Рабочее место" }));
    await settle();
    expect(lastProps().isLeaving()).toBe(true);
    expect(screen.queryByRole("heading", { name: "Рабочее место" })).toBeNull();
    await act(async () => releaseWork());
    expect(await screen.findByRole("button", { name: "Добавить принтер" })).toBeTruthy();
    expect(screens.unmounts).toBe(1);
    await pastTheSetupGuard();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("Склад (заглушка)");
    // A fresh screen of the same session, taking scans.
    expect(screens.mounts).toBe(2);
    expect(lastProps().isLeaving()).toBe(false);
    expect(screen.queryByRole("button", { name: "Открыть" })).toBeNull();
    expect(types(handlers)).not.toContain("work_left");
    expect(types(handlers)).not.toContain("work_entered");
  });

  it("opens the setup from the list as before, and comes back to the list", async () => {
    const local = await copies();
    render(floorOf(local, handlersOf()));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочее место" }));
    await pastTheSetupGuard();
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: REPRINT })).toBeTruthy();
    expect(screens.mounts).toBe(0);
  });
});

describe("a warehouse reprint the floor was not given", () => {
  it("shows no button, and no warehouse screen", async () => {
    const local = await copies();
    const handlers = handlersOf();
    render(
      <ThemeProvider>
        <FloorApp
          operator={SESSION}
          local={local}
          device={DEVICE_STATUS}
          link={ONLINE}
          sync={SYNCED}
          shiftReads={{ done: 1, failed: false }}
          lineChangePending={false}
          rejectionPending={false}
          enter={vi.fn()}
          create={vi.fn()}
          checkCode={vi.fn()}
          requestBlock={vi.fn()}
          requestFacts={handlers.requestFacts}
          source={SILENT_SOURCE}
          printing={handlers.printing}
          hardware={handlers.hardware}
          awake={handlers.awake}
          dispatch={handlers.dispatch}
          onSignOut={handlers.onSignOut}
        />
      </ThemeProvider>,
    );
    await screen.findByRole("button", { name: "Открыть" });
    expect(screen.queryByRole("button", { name: REPRINT })).toBeNull();
  });
});
