import { readFileSync } from "node:fs";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, FloorSession, ShellAction, SyncState } from "../src/app/shell.js";
import { FloorApp } from "../src/floor/FloorApp.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "../src/floor/idle-lock.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import {
  keepEnteredShift,
  readShiftCopy,
  replaceShiftCopies,
} from "../src/floor/shifts/shift-copies.js";
import {
  readWorkstationSettings,
  saveWorkstationSettings,
} from "../src/floor/setup/workstation-settings.js";
import { readOperatorCopy, signInWithPin } from "../src/floor/sign-in.js";
import { playSignalTone } from "../src/floor/work/signal-sound.js";
import { WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import { HostError } from "../src/host/client.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type ChangeItem,
  type ChangesResponse,
  type CodeCheck,
  type DeviceShift,
  type DeviceShiftCreate,
  type DeviceStatus,
  type EnteredShift,
  type HostStatus,
  type SsccBlock,
  type SsccBlockRequest,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { enteredShift } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";

// The tones are the work screen's; the floor only gives them a level.
vi.mock("../src/floor/work/signal-sound.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playSignalTone: vi.fn(),
}));

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const CATALOG = (fixture("changes-catalog.json") as ChangesResponse).items;
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
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
const OPENED: EnteredShift = {
  ...ENTERED,
  id: PLANNED.id,
  number: PLANNED.number,
  ownerDeviceId: DEVICE_ID,
};
const SEEN = 1_790_000_000_000;

/** What the host makes of a create: the shift as the form asked for it. */
async function madeAsAsked(body: DeviceShiftCreate): Promise<DeviceShift> {
  return {
    ...PLANNED,
    productId: body.productId,
    boxTemplateId: body.boxTemplateId,
    productionDate: body.productionDate,
    boxCapacity: body.boxCapacity ?? PLANNED.boxCapacity,
    plannedQty: body.plannedQty ?? null,
  };
}

async function synced(items: ChangeItem[], rev = 10): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

const SILENT_SOURCE: ScanSource = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

interface Options {
  device?: DeviceStatus;
  link?: HostStatus | null;
  source?: ScanSource;
  sync?: SyncState;
  shiftReads?: { done: number; failed: boolean };
  lineChangePending?: boolean;
  rejectionPending?: boolean;
  idleTimeoutMs?: number;
  workScreen?: ComponentType<WorkScreenProps>;
  warehouseLookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  outboxVersion?: number;
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
        device={options.device ?? DEVICE_STATUS}
        link={options.link === undefined ? ONLINE : options.link}
        sync={options.sync ?? SYNCED}
        shiftReads={options.shiftReads ?? { done: 1, failed: false }}
        lineChangePending={options.lineChangePending ?? false}
        rejectionPending={options.rejectionPending ?? false}
        {...(options.outboxVersion === undefined ? {} : { outboxVersion: options.outboxVersion })}
        enter={handlers.enter}
        create={handlers.create}
        checkCode={handlers.checkCode}
        requestBlock={handlers.requestBlock}
        requestFacts={handlers.requestFacts}
        {...(options.warehouseLookup === undefined
          ? {}
          : { warehouseLookup: options.warehouseLookup })}
        source={options.source ?? SILENT_SOURCE}
        printing={handlers.printing}
        hardware={handlers.hardware}
        awake={handlers.awake}
        {...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs })}
        {...(options.workScreen === undefined ? {} : { workScreen: options.workScreen })}
        dispatch={handlers.dispatch}
        onSignOut={handlers.onSignOut}
      />
    </ThemeProvider>
  );
}

function handlersOf(
  answers: {
    enter?: (shiftId: string) => Promise<EnteredShift>;
    create?: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  } = {},
) {
  return {
    enter: vi.fn(answers.enter ?? (async () => OPENED)),
    create: vi.fn(answers.create ?? (async () => PLANNED)),
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest): Promise<SsccBlock> => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 1500,
      toSerial: 3499,
    })),
    requestFacts: vi.fn(),
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    hardware: fakeHardware().hardware,
    awake: createSystemAwake(vi.fn(async () => undefined)),
    dispatch: vi.fn<(action: ShellAction) => void>(),
    onSignOut: vi.fn<(notice: FloorNotice | null) => void>(),
  };
}

/** The copies with Anna and the line's planned shift. */
async function floorCopies(items: ChangeItem[] = [OPERATOR]): Promise<LocalExecutor> {
  const local = await synced(items);
  await replaceShiftCopies(local, PAIRING, [PLANNED], SEEN);
  return local;
}

function types(handlers: ReturnType<typeof handlersOf>): string[] {
  return handlers.dispatch.mock.calls.map(([action]) => action.type);
}

async function enterPlanned(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
}

/** Two turns of React's effect scheduler and the promises they started. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/**
 * A work screen that does nothing of its own but the floor's leave: for a test
 * of the floor that holds or counts the database's reads, which the real
 * screen makes of its own on entry.
 */
function IdleWork(props: WorkScreenProps) {
  return (
    <div>
      <p>{`Смена ${props.shift.copy.number}`}</p>
      <button type="button" onClick={props.onLeave}>
        Выйти из смены
      </button>
    </div>
  );
}

/** A work screen that holds the leave with a piece of work the test settles. */
function holdingWork() {
  let release: () => void = () => undefined;
  let fail: () => void = () => undefined;
  const leaving: boolean[] = [];
  const officeClosed: boolean[] = [];
  let touch: () => void = () => undefined;
  let tracking = false;
  const seen: WorkScreenProps[] = [];
  function Work(props: WorkScreenProps) {
    const { track } = props;
    seen.push(props);
    useEffect(() => {
      tracking = true;
      void track(
        new Promise<void>((resolve, reject) => {
          release = resolve;
          fail = () => reject(new Error("disk"));
        }),
      ).catch(() => undefined);
    }, [track]);
    touch = props.touch;
    leaving.push(props.leaving);
    officeClosed.push(props.officeClosed ?? false);
    return (
      <button type="button" onClick={props.onLeave}>
        {`Работа ${props.shift.copy.number}`}
      </button>
    );
  }
  return {
    Work,
    release: () => act(async () => release()),
    fail: () => act(async () => fail()),
    leaving,
    /** Whether the floor said the office closed the shift, at every render (plan 2a8). */
    officeClosed,
    /** Every set of properties the floor gave the screen, in order. */
    seen,
    touch: () => touch(),
    /** The screen's effect has handed its work to the gate: only then may the test leave. */
    tracked: () =>
      waitFor(() => {
        if (!tracking) throw new Error("the work screen has not tracked its work yet");
      }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the floor after an operator signed in", () => {
  it("enters a shift into its work screen, tells the shell, and comes back to the list", async () => {
    const handlers = handlersOf();
    const view = render(floorOf(await floorCopies(), handlers));
    await enterPlanned();
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: "work_entered",
      sessionId: 1,
      shiftId: PLANNED.id,
    });
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.className).toContain("mk-btn--floor");
    fireEvent.click(leave);
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(handlers.dispatch).toHaveBeenCalledWith({ type: "work_left", sessionId: 1 });
    view.unmount();
  });

  const SIGNED_IN = "Вошёл: Анна Кузнецова, табельный номер 0042.";

  it("gives the focus to the list once the operator is back on it from a shift, held work or not", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    const leave = await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    leave.focus();
    fireEvent.click(leave);
    await settle();
    // The work is not over: the screen of the shift is still there.
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    await work.release();
    const prompt = await screen.findByText(SIGNED_IN);
    expect(document.activeElement).toBe(prompt);
  });

  it("gives the focus to the list when the operator turns back from a new shift", async () => {
    render(floorOf(await floorCopies(), handlersOf()));
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    const back = await screen.findByRole("button", { name: "Назад" });
    back.focus();
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    const prompt = await screen.findByText(SIGNED_IN);
    expect(document.activeElement).toBe(prompt);
  });

  it("leaves the shift only once the work its screen tracks has settled", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Работа OCT26-005/S" }));
    await settle();
    expect(work.leaving.at(-1)).toBe(true);
    expect(types(handlers)).not.toContain("work_left");
    await work.release();
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(types(handlers)).toContain("work_left");
  });

  it("tells the work screen at once that the operator is leaving, until the next shift is entered", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    const first = work.seen.at(-1);
    expect(first?.isLeaving?.()).toBe(false);
    // A leave that a timer or an answer started: asked for, and no render has shown it yet.
    act(() => {
      first?.onLeave();
      expect(first?.isLeaving?.()).toBe(true);
    });
    await work.release();
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    expect(work.seen.at(-1)?.isLeaving?.()).toBe(false);
  });

  it("tells the work screen when the link is held for the rest of the shift", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    const local = await floorCopies();
    const view = render(floorOf(local, handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    expect(work.seen.at(-1)?.linkHeld).toBe(false);
    // A refusal or another host found while the operator works: held until they leave.
    view.rerender(floorOf(local, handlers, { workScreen: work.Work, rejectionPending: true }));
    expect(work.seen.at(-1)?.linkHeld).toBe(true);
  });

  it("is not held for good by tracked work that failed", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Работа OCT26-005/S" }));
    await work.fail();
    await waitFor(() => expect(types(handlers)).toContain("work_left"));
  });

  it("drops a leave whose work settles after the floor is gone", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    const view = render(floorOf(await floorCopies(), handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Работа OCT26-005/S" }));
    view.unmount();
    await work.release();
    await settle();
    expect(types(handlers)).not.toContain("work_left");
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("signs the operator out as idle at once on the list, and after the work in a shift", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const first = handlersOf();
    const view = render(floorOf(local, first, { idleTimeoutMs: 3_000 }));
    await screen.findByRole("button", { name: "Открыть" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(first.onSignOut).toHaveBeenCalledWith("idle");
    view.unmount();

    const second = handlersOf();
    const work = holdingWork();
    render(floorOf(local, second, { idleTimeoutMs: 3_000, workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(second.onSignOut).not.toHaveBeenCalled();
    expect(work.leaving.at(-1)).toBe(true);
    await work.release();
    await waitFor(() => expect(second.onSignOut).toHaveBeenCalledWith("idle"));
    // The shell hears the work end before the sign-out.
    const order = second.dispatch.mock.invocationCallOrder.at(-1) ?? 0;
    expect(order).toBeLessThan(second.onSignOut.mock.invocationCallOrder[0] ?? 0);
  });

  it("stops the idle wait with the floor: nobody is signed out by a floor that is gone", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers, { idleTimeoutMs: 20_000 }));
    await screen.findByRole("button", { name: "Открыть" });
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("starts the idle wait again when the work screen touches it (a COM scan presses no key)", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const handlers = handlersOf();
    const work = holdingWork();
    render(floorOf(local, handlers, { idleTimeoutMs: 4_000, workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    // Margins of 1 500 ms on both sides of the touch: the clock also runs with real time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    work.touch();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(work.leaving.at(-1)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_700);
    });
    expect(work.leaving.at(-1)).toBe(true);
  });

  it("signs out an operator a sync took out of the copies, after the work", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const work = holdingWork();
    const view = render(floorOf(local, handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
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
    view.rerender(
      floorOf(local, handlers, { workScreen: work.Work, sync: { ...SYNCED, synced: 2 } }),
    );
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("brings a new name and role from the copies after a sync, without a new session", async () => {
    const renamed = {
      ...OPERATOR,
      rev: 6,
      data: { login: "0042", name: "Анна Петрова", role: "Бригадир", pinPhc: PIN_PHC },
    };
    const handlers = handlersOf();
    render(floorOf(await floorCopies([renamed]), handlers));
    await waitFor(() =>
      expect(handlers.dispatch).toHaveBeenCalledWith({
        type: "operator_refreshed",
        sessionId: 1,
        name: "Анна Петрова",
        role: "Бригадир",
      }),
    );
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("signs nobody out and refreshes nothing on copies that are not this pairing's yet", async () => {
    const handlers = handlersOf();
    const { executor } = openLocalDb();
    render(floorOf(executor, handlers));
    await screen.findByText(
      "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
    );
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(types(handlers)).not.toContain("operator_refreshed");
  });

  it("keeps the operator in the shift the office closed, to finish it, and takes no new code", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers));
    await enterPlanned();
    await screen.findByText("Смена OCT26-005/S");
    await replaceShiftCopies(
      local,
      PAIRING,
      [{ ...OPENED, status: "closed", closedAt: "2026-10-09T18:00:00Z" }],
      SEEN + 1,
    );
    view.rerender(floorOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("Смену закрыли в офисе")).toBeTruthy();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers)).not.toContain("work_left");
    // Back in the list it waits to be finished, and «Завершить» comes back to it.
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    expect(await screen.findByText("Смену закрыли в офисе")).toBeTruthy();
    expect(handlers.enter).toHaveBeenCalledTimes(1);
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("stays in the shift after a read that finds it still open", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers));
    await enterPlanned();
    await screen.findByText("Смена OCT26-005/S");
    await replaceShiftCopies(local, PAIRING, [OPENED], SEEN + 1);
    view.rerender(floorOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    await settle();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers)).not.toContain("work_left");
  });

  it("leaves the shift for another line once the work is done, and nothing more", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const work = holdingWork();
    const view = render(floorOf(local, handlers, { workScreen: work.Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    view.rerender(floorOf(local, handlers, { workScreen: work.Work, lineChangePending: true }));
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    expect(types(handlers)).not.toContain("work_left");
    await work.release();
    await waitFor(() => expect(types(handlers)).toContain("work_left"));
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("opens the new shift and comes back to the list", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    expect(await screen.findByText("Новая смена", { selector: "h2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
  });

  it("signs the operator out on «Сменить оператора»", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Сменить оператора" }));
    expect(handlers.onSignOut).toHaveBeenCalledWith(null);
  });
});

describe("the work screen of plan 2a5", () => {
  it("names the shift and its product from the snapshot", async () => {
    const local = await floorCopies();
    await keepEnteredShift(local, PAIRING, OPENED, "2026-10-09T06:00:00.000Z", SEEN);
    const handlers = handlersOf();
    render(floorOf(local, handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(screen.getByText("Молоко 3,2% 0,9 л · GTIN 04600682000013")).toBeTruthy();
    expect(screen.getByText("Отсканируйте код маркировки.")).toBeTruthy();
  });
});

describe("the work screen the floor mounts", () => {
  it("gets the scanner, the host's calls, and a link that a waiting refusal stops", async () => {
    const seen: WorkScreenProps[] = [];
    function Work(props: WorkScreenProps) {
      seen.push(props);
      return (
        <button type="button" onClick={props.onRecorded}>
          {`Работа ${props.shift.copy.number}`}
        </button>
      );
    }
    const handlers = handlersOf();
    const local = await floorCopies();
    const view = render(floorOf(local, handlers, { workScreen: Work }));
    await enterPlanned();
    fireEvent.click(await screen.findByRole("button", { name: "Работа OCT26-005/S" }));
    expect(handlers.requestFacts).toHaveBeenCalledTimes(1);
    expect(types(handlers)).toContain("outbox_changed");
    const props = seen.at(-1);
    expect(props?.online).toBe(true);
    expect(props?.source).toBe(SILENT_SOURCE);
    expect(props?.checkCode).toBe(handlers.checkCode);
    expect(props?.requestBlock).toBe(handlers.requestBlock);
    view.rerender(floorOf(local, handlers, { workScreen: Work, rejectionPending: true }));
    expect(seen.at(-1)?.online).toBe(false);
  });

  it("tells the shell of a refused key that a call of the screen met", async () => {
    let hostError: (error: unknown) => void = () => undefined;
    function Work(props: WorkScreenProps) {
      hostError = props.onHostError;
      return <p>{`Работа ${props.shift.copy.number}`}</p>;
    }
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers, { workScreen: Work }));
    await enterPlanned();
    await screen.findByText("Работа OCT26-005/S");
    hostError(
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
    // An error the shell has nothing to do with is the screen's own.
    handlers.dispatch.mockClear();
    hostError(new Error("disk"));
    expect(handlers.dispatch).not.toHaveBeenCalled();
  });
});

describe("the work screen's product", () => {
  it("is the one the shift's snapshot froze, whatever the list says of it now", async () => {
    const renamed: EnteredShift = {
      ...OPENED,
      snapshot: {
        ...OPENED.snapshot,
        product: { ...OPENED.snapshot.product, name: "Молоко из снимка" },
      },
    };
    const handlers = handlersOf({ enter: async () => renamed });
    render(floorOf(await floorCopies(), handlers));
    await enterPlanned();
    expect(await screen.findByText("Молоко из снимка · GTIN 04600682000013")).toBeTruthy();
    expect(screen.queryByText(/Молоко 3,2% 0,9 л/)).toBeNull();
  });
});

/** The warehouse screen takes no press for 400 ms after its view changed (`useViewGuard`). */
async function pastTheViewGuard(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

describe("the warehouse reprint on the floor (plan СКЛ)", () => {
  it("opens from the list of shifts only when the host can be asked, and comes back to it", async () => {
    const handlers = handlersOf();
    const { unmount } = render(floorOf(await floorCopies(), handlers));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторная печать этикеток" })).toBeNull();
    unmount();
    const lookup = vi.fn(async (): Promise<WarehouseLookupResult> => ({ status: "not_found" }));
    render(floorOf(await floorCopies(), handlers, { warehouseLookup: lookup }));
    fireEvent.click(await screen.findByRole("button", { name: "Повторная печать этикеток" }));
    expect(await screen.findByRole("heading", { name: "Повторная печать этикеток" })).toBeTruthy();
    // The screen holds a press that lands just after its view changed (400 ms).
    await pastTheViewGuard();
    fireEvent.click(await screen.findByRole("button", { name: "К сменам" }));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(types(handlers)).not.toContain("work_entered");
    expect(types(handlers)).not.toContain("work_left");
  });
});

describe("the workstation setup on the floor", () => {
  it("opens from the list of shifts and comes back to it", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочее место" }));
    expect(await screen.findByRole("heading", { name: "Принтеры" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(types(handlers)).not.toContain("work_entered");
  });

  it("opens from a label's recovery once the work settled, and comes back to the same shift", async () => {
    const handlers = handlersOf();
    const work = holdingWork();
    function Work(props: WorkScreenProps) {
      return (
        <>
          <work.Work {...props} />
          <button type="button" onClick={props.onSetup}>
            Настроить принтер
          </button>
        </>
      );
    }
    render(floorOf(await floorCopies(), handlers, { workScreen: Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Настроить принтер" }));
    await settle();
    // The work it handed over holds the setup back, as it holds any leave.
    expect(screen.queryByRole("heading", { name: "Принтеры" })).toBeNull();
    expect(work.leaving.at(-1)).toBe(true);
    await work.release();
    expect(await screen.findByRole("heading", { name: "Принтеры" })).toBeTruthy();
    const workActions = () => types(handlers).filter((type) => type.startsWith("work_"));
    expect(workActions()).toEqual(["work_entered", "work_left"]);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Работа OCT26-005/S" })).toBeTruthy();
    expect(workActions()).toEqual(["work_entered", "work_left", "work_entered"]);
    expect(handlers.dispatch).toHaveBeenLastCalledWith({
      type: "work_entered",
      sessionId: 1,
      shiftId: PLANNED.id,
    });
  });
});

describe("the queue of what was not sent on the floor (plan ОЧ)", () => {
  it("opens from the list of shifts and comes back to it, telling the shell of no work", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Очередь отправки" }));
    expect(await screen.findByRole("heading", { name: "Очередь отправки" })).toBeTruthy();
    expect(await screen.findByText("Все записи отправлены.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("heading", { name: "Смены линии" })).toBeTruthy();
    expect(types(handlers)).not.toContain("work_entered");
    expect(types(handlers)).not.toContain("work_left");
  });

  it("tells the shell and asks for the outbox when a decision is written, and shows the link", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [OPERATOR] }),
      local: executor,
      ...PAIRING,
    });
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('r1', ?, ?, 'scan', ?, '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'not_entered', '2026-10-08T06:30:00.000Z')",
    ).run(HOST_ID, DEVICE_ID, PLANNED.id);
    const handlers = handlersOf();
    render(floorOf(executor, handlers));
    fireEvent.click(await screen.findByRole("button", { name: "Очередь отправки" }));
    expect(await screen.findByText("На связи с хостом")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await screen.findByRole("group", { name: "Подтверждение" });
    // The press guard of the question: the second tap of a double tap decides nothing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
    expect(types(handlers)).toContain("outbox_changed");
    expect(handlers.requestFacts).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT resolution, resolved_by FROM outbox WHERE id = 'r1'").get(),
    ).toMatchObject({ resolution: "dismissed", resolved_by: ANNA.id });
  });

  it("reads the queue again when the shell says the outbox changed", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [OPERATOR] }),
      local: executor,
      ...PAIRING,
    });
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN);
    const handlers = handlersOf();
    const view = render(floorOf(executor, handlers, { outboxVersion: 0 }));
    fireEvent.click(await screen.findByRole("button", { name: "Очередь отправки" }));
    await screen.findByText("Отклонённых записей нет.");
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('r2', ?, ?, 'scan', ?, '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'gtin_mismatch', '2026-10-08T06:30:00.000Z')",
    ).run(HOST_ID, DEVICE_ID, PLANNED.id);
    view.rerender(floorOf(executor, handlers, { outboxVersion: 1 }));
    expect(await screen.findByText("Код другого товара, не товара смены")).toBeTruthy();
  });

  it("signs the operator out as idle in the queue as on the list", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const handlers = handlersOf();
    render(floorOf(local, handlers, { idleTimeoutMs: 3_000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Очередь отправки" }));
    await screen.findByRole("heading", { name: "Очередь отправки" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(handlers.onSignOut).toHaveBeenCalledWith("idle");
  });
});

/** A work screen that holds nothing and has the «Настроить принтер» entry of a label's recovery. */
function WorkWithSetup(props: WorkScreenProps) {
  return (
    <>
      <p>{`Смена ${props.shift.copy.number}`}</p>
      {props.officeClosed === true && <p>Закрыта в офисе</p>}
      <button type="button" onClick={props.onSetup}>
        Настроить принтер
      </button>
    </>
  );
}

describe("what the workstation setup does to the floor around it", () => {
  async function inTheSetupFromTheWork(options: Options = {}) {
    const local = await floorCopies();
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers, { workScreen: WorkWithSetup, ...options }));
    await enterPlanned();
    fireEvent.click(await screen.findByRole("button", { name: "Настроить принтер" }));
    await screen.findByRole("heading", { name: "Принтеры" });
    return { local, handlers, view };
  }

  it("reads the shift again on the way back: one the office closed meanwhile is entered to be finished", async () => {
    const { local, handlers } = await inTheSetupFromTheWork();
    await replaceShiftCopies(
      local,
      PAIRING,
      [{ ...OPENED, status: "closed", closedAt: "2026-10-09T18:00:00Z" }],
      SEEN + 1,
    );
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByText("Закрыта в офисе")).toBeTruthy();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers).filter((type) => type === "work_entered")).toHaveLength(2);
  });

  it("goes back to the list when the shift cannot be read again, and enters nothing", async () => {
    const { local, handlers, view } = await inTheSetupFromTheWork();
    const broken: LocalExecutor = {
      ...local,
      query: (sql, params, row) =>
        sql.includes("snapshot")
          ? Promise.reject(new Error("disk I/O error"))
          : local.query(sql, params, row),
    };
    view.rerender(floorOf(broken, handlers, { workScreen: WorkWithSetup }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(types(handlers).filter((type) => type === "work_entered")).toHaveLength(1);
  });

  it("enters the shift once however many times «Назад» is pressed", async () => {
    const { handlers } = await inTheSetupFromTheWork();
    const back = screen.getByRole("button", { name: "Назад" });
    await act(async () => {
      fireEvent.click(back);
      fireEvent.click(back);
    });
    expect(await screen.findByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers).filter((type) => type === "work_entered")).toHaveLength(2);
  });

  it("tells the shell the work ended before the setup shows, and not again on the list's setup", async () => {
    const { handlers } = await inTheSetupFromTheWork();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
    const local = await floorCopies();
    const fromList = handlersOf();
    render(floorOf(local, fromList));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочее место" }));
    await screen.findByRole("heading", { name: "Принтеры" });
    expect(types(fromList).filter((type) => type.startsWith("work_"))).toEqual([]);
  });

  it("lets a setup that still waits for the work go on when the office closes the shift", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const work = holdingWork();
    function Work(props: WorkScreenProps) {
      return (
        <>
          <work.Work {...props} />
          <button type="button" onClick={props.onSetup}>
            Настроить принтер
          </button>
        </>
      );
    }
    const view = render(floorOf(local, handlers, { workScreen: Work }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Работа OCT26-005/S" });
    await work.tracked();
    fireEvent.click(screen.getByRole("button", { name: "Настроить принтер" }));
    await settle();
    await replaceShiftCopies(
      local,
      PAIRING,
      [{ ...OPENED, status: "closed", closedAt: "2026-10-09T18:00:00Z" }],
      SEEN + 1,
    );
    view.rerender(
      floorOf(local, handlers, { workScreen: Work, shiftReads: { done: 2, failed: false } }),
    );
    await settle();
    await work.release();
    expect(await screen.findByRole("heading", { name: "Принтеры" })).toBeTruthy();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
  });

  it("signs the operator out as idle in the setup as on the list", async () => {
    const local = await floorCopies();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const handlers = handlersOf();
    render(floorOf(local, handlers, { idleTimeoutMs: 3_000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочее место" }));
    await screen.findByRole("heading", { name: "Принтеры" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(handlers.onSignOut).toHaveBeenCalledWith("idle");
  });

  it("signs the operator out of a setup opened from the work, after the work", async () => {
    const { handlers } = await inTheSetupFromTheWork({ idleTimeoutMs: 3_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    fireEvent.pointerDown(window);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(handlers.onSignOut).toHaveBeenCalledWith("idle");
  });
});

describe("the level of the verdict tones", () => {
  function Tones(props: WorkScreenProps) {
    return (
      <>
        <button type="button" onClick={() => props.signal?.("ok")}>
          Сигнал
        </button>
        <button type="button" onClick={props.onSetup}>
          Настроить принтер
        </button>
      </>
    );
  }

  async function inTheWork(sound?: { muted: boolean; volume: number }) {
    const local = await floorCopies();
    if (sound !== undefined) {
      const settings = await readWorkstationSettings(local);
      await saveWorkstationSettings(local, { ...settings, sound });
    }
    vi.mocked(playSignalTone).mockClear();
    render(floorOf(local, handlersOf(), { workScreen: Tones }));
    await enterPlanned();
    await screen.findByRole("button", { name: "Сигнал" });
    await settle();
    return local;
  }

  const lastLevel = () => vi.mocked(playSignalTone).mock.lastCall;

  it("plays at the default level on a computer with no sound setting", async () => {
    await inTheWork();
    fireEvent.click(screen.getByRole("button", { name: "Сигнал" }));
    expect(lastLevel()).toEqual(["ok", undefined, 0.8]);
  });

  it("plays at the stored level, and none when the sound is muted", async () => {
    await inTheWork({ muted: false, volume: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Сигнал" }));
    expect(lastLevel()).toEqual(["ok", undefined, 0.3]);
    cleanup();
    await inTheWork({ muted: true, volume: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Сигнал" }));
    expect(lastLevel()).toEqual(["ok", undefined, 0]);
  });

  it("takes the level the setup stored, at once, back in the shift", async () => {
    const local = await inTheWork();
    const settings = await readWorkstationSettings(local);
    await saveWorkstationSettings(local, { ...settings, sound: { muted: false, volume: 40 } });
    fireEvent.click(screen.getByRole("button", { name: "Настроить принтер" }));
    fireEvent.click(await screen.findByRole("button", { name: "Добавить принтер" }));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Zebra" } });
    fireEvent.change(screen.getByLabelText("Адрес принтера"), { target: { value: "zebra" } });
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    await screen.findByText("Настройки сохранены.");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сигнал" }));
    expect(lastLevel()).toEqual(["ok", undefined, 0.4]);
  });
});

describe("the level the setup's own sound controls give the tones", () => {
  function Tones(props: WorkScreenProps) {
    return (
      <>
        <button type="button" onClick={() => props.signal?.("error")}>
          Сигнал
        </button>
        <button type="button" onClick={props.onSetup}>
          Настроить принтер
        </button>
      </>
    );
  }

  it("is the level chosen there and saved, and silence for «Без звука»", async () => {
    const local = await floorCopies();
    vi.mocked(playSignalTone).mockClear();
    render(floorOf(local, handlersOf(), { workScreen: Tones }));
    await settle();
    await enterPlanned();
    fireEvent.click(await screen.findByRole("button", { name: "Настроить принтер" }));
    // The sound is the setup's own tab (the cloud station's layout).
    fireEvent.click(await screen.findByRole("tab", { name: "Звук" }));
    fireEvent.click(await screen.findByRole("button", { name: "Тише" }));
    fireEvent.click(screen.getByRole("button", { name: "Тише" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    await screen.findByText("Настройки сохранены.");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сигнал" }));
    expect(vi.mocked(playSignalTone).mock.lastCall).toEqual(["error", undefined, 0.6]);
    fireEvent.click(screen.getByRole("button", { name: "Настроить принтер" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Звук" }));
    fireEvent.click(await screen.findByRole("button", { name: "Без звука" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    });
    await screen.findByText("Настройки сохранены.");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сигнал" }));
    expect(vi.mocked(playSignalTone).mock.lastCall).toEqual(["error", undefined, 0]);
  });

  it("is not changed by a setup that was left without saving", async () => {
    const local = await floorCopies();
    vi.mocked(playSignalTone).mockClear();
    render(floorOf(local, handlersOf(), { workScreen: Tones }));
    await settle();
    await enterPlanned();
    fireEvent.click(await screen.findByRole("button", { name: "Настроить принтер" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Звук" }));
    fireEvent.click(await screen.findByRole("button", { name: "Без звука" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад без сохранения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Сигнал" }));
    expect(vi.mocked(playSignalTone).mock.lastCall).toEqual(["error", undefined, 0.8]);
  });
});

describe("the operator a sign-in hands over", () => {
  it("is a new object of identity fields only each time, never the credential's row", async () => {
    const context = {
      local: await synced([OPERATOR]),
      pairing: PAIRING,
      now: () => 1_790_000_000_000,
    };
    const first = await signInWithPin(context, "0042", "4821");
    const second = await signInWithPin(context, "0042", "4821");
    if (first.kind !== "signed_in" || second.kind !== "signed_in") throw new Error("not signed in");
    expect(second.operator).not.toBe(first.operator);
    expect(Object.keys(first.operator).sort()).toEqual(["id", "login", "name", "role"]);
    expect(first.operator).toEqual(ANNA);
  });
});

describe("the operator idle lock", () => {
  it("waits ten minutes by default, and every touch starts the wait again", () => {
    vi.useFakeTimers();
    expect(OPERATOR_IDLE_TIMEOUT_MS).toBe(600_000);
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle });
    lock.start();
    vi.advanceTimersByTime(599_999);
    fireEvent.pointerDown(window);
    vi.advanceTimersByTime(599_999);
    fireEvent.keyDown(window, { key: "1" });
    vi.advanceTimersByTime(599_999);
    lock.touch();
    vi.advanceTimersByTime(599_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Once idle, it waits for nothing more until started again: not a touch either.
    fireEvent.pointerDown(window);
    lock.touch();
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    lock.stop();
  });

  it("restarts the wait on a touch of the screen as on a press", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    vi.advanceTimersByTime(999);
    fireEvent.touchStart(window);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    lock.stop();
  });

  it("listens for exactly a pointer, a key and a touch, and removes the same listeners", () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const target = {
      addEventListener: (type: string, listener: unknown) => void added.push([type, listener]),
      removeEventListener: (type: string, listener: unknown) => void removed.push([type, listener]),
    };
    const lock = createOperatorIdleLock({ target, onIdle: () => undefined, timeoutMs: 1_000 });
    lock.stop();
    expect(removed).toEqual([]);
    lock.start();
    expect(added.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown", "touchstart"]);
    lock.stop();
    expect(removed.slice().sort()).toEqual(added.slice().sort());
    lock.stop();
    expect(removed).toHaveLength(3);
  });

  it("stops listening when stopped, and a touch after it starts nothing", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const lock = createOperatorIdleLock({ target: window, onIdle, timeoutMs: 1_000 });
    lock.start();
    lock.stop();
    fireEvent.pointerDown(window);
    lock.touch();
    vi.advanceTimersByTime(2_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** The copies as they are, but once `hold()` is called every query waits for `release()`. */
function gatedExecutor(real: LocalExecutor) {
  let pending: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const local: LocalExecutor = {
    query: (sql, params, row) => {
      const wait = pending;
      return wait === null
        ? real.query(sql, params, row)
        : wait.then(() => real.query(sql, params, row));
    },
    transaction: (statements) => real.transaction(statements),
  };
  return {
    local,
    hold() {
      pending = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
    },
  };
}

/** A scanner the test reads into. */
function fakeSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return {
    source,
    listening: () => listener !== null,
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

/** This station begins to close the planned shift (plan 2a8 does this; the floor only reads it). */
async function closeLocally(local: LocalExecutor, state: "closing" | "closed"): Promise<void> {
  await local.transaction([
    {
      sql: "UPDATE floor_shifts SET local_state = ? WHERE host_id = ? AND device_id = ? AND id = ?",
      values: [state, HOST_ID, DEVICE_ID, PLANNED.id],
      expectedChanges: 1,
    },
  ]);
}

/** The office closes the shift: the host's next list says so. */
function officeCloses(local: LocalExecutor, seenAt: number): Promise<void> {
  return replaceShiftCopies(
    local,
    PAIRING,
    [{ ...OPENED, status: "closed", closedAt: "2026-10-09T18:00:00Z" }],
    seenAt,
  );
}

const WORK_BUTTON = "Работа OCT26-005/S";

/** Anna is in the planned shift, with a work screen that holds the leave. */
async function inTheWork(options: Options = {}, handlers = handlersOf()) {
  const local = await floorCopies();
  const work = holdingWork();
  const view = render(floorOf(local, handlers, { workScreen: work.Work, ...options }));
  await enterPlanned();
  await screen.findByRole("button", { name: WORK_BUTTON });
  await work.tracked();
  const again = (next: Options = {}) =>
    view.rerender(floorOf(local, handlers, { workScreen: work.Work, ...options, ...next }));
  return { local, work, view, handlers, again };
}

describe("an entry whose answer comes late (the work gate, minors 6 and 10)", () => {
  it("enters a shift the office closed on the way, to finish it, without new codes", async () => {
    const local = await floorCopies();
    const answer = deferred<EnteredShift>();
    const handlers = handlersOf({ enter: () => answer.promise });
    const work = holdingWork();
    render(floorOf(local, handlers, { workScreen: work.Work }));
    await enterPlanned();
    await waitFor(() => expect(handlers.enter).toHaveBeenCalledTimes(1));
    // The host's list that says «closed» lands before the answer of the entry.
    await replaceShiftCopies(
      local,
      PAIRING,
      [{ ...PLANNED, status: "closed", closedAt: "2026-10-09T18:00:00Z" }],
      SEEN + 1,
    );
    answer.resolve(OPENED);
    expect(await screen.findByRole("button", { name: WORK_BUTTON })).toBeTruthy();
    expect(work.officeClosed.at(-1)).toBe(true);
    expect(types(handlers)).toContain("work_entered");
    expect(types(handlers)).not.toContain("work_left");
    // The shift is entered and kept, as the host's answer was, but it stays closed.
    expect(await readShiftCopy(local, PAIRING, PLANNED.id)).toMatchObject({
      entered: true,
      status: "closed",
    });
  });

  it("turns back a shift this station began to close on the way, without blaming the office", async () => {
    const local = await floorCopies();
    await keepEnteredShift(local, PAIRING, OPENED, "2026-10-09T06:00:00.000Z", SEEN);
    const answer = deferred<EnteredShift>();
    const handlers = handlersOf({ enter: () => answer.promise });
    const work = holdingWork();
    render(floorOf(local, handlers, { workScreen: work.Work }));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.enter).toHaveBeenCalledTimes(1));
    await closeLocally(local, "closing");
    answer.resolve(OPENED);
    // The list shows the shift as it is now: closing, with its entry off.
    const closing = await screen.findByRole("button", { name: "Закрывается" });
    expect(closing).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();
    expect(screen.queryByRole("button", { name: WORK_BUTTON })).toBeNull();
    expect(types(handlers)).not.toContain("work_entered");
  });

  it("opens no work screen and tells the shell of no `work_entered` for a shift this station is closing, whatever the office did meanwhile", async () => {
    const local = await floorCopies();
    await keepEnteredShift(local, PAIRING, OPENED, "2026-10-09T06:00:00.000Z", SEEN);
    const answer = deferred<EnteredShift>();
    const handlers = handlersOf({ enter: () => answer.promise });
    const work = holdingWork();
    render(floorOf(local, handlers, { workScreen: work.Work }));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.enter).toHaveBeenCalledTimes(1));
    await closeLocally(local, "closing");
    await officeCloses(local, SEEN + 1);
    answer.resolve(OPENED);
    await settle();
    await waitFor(() => expect(handlers.enter).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: WORK_BUTTON })).toBeNull();
    expect(types(handlers)).not.toContain("work_entered");
  });
});

describe("«Назад» from the new shift (minor 13)", () => {
  async function toTheForm(handlers: ReturnType<typeof handlersOf>) {
    const local = await floorCopies([OPERATOR, ...CATALOG]);
    const work = holdingWork();
    const view = render(floorOf(local, handlers, { workScreen: work.Work }));
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "мол" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Молоко 3,2% 0,9 л — 04600682000013" }));
    await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
    const again = (next: Options) =>
      view.rerender(floorOf(local, handlers, { workScreen: work.Work, ...next }));
    return { local, work, again };
  }

  it("follows the link: with the host gone it creates nothing", async () => {
    const handlers = handlersOf({ create: madeAsAsked });
    const { again } = await toTheForm(handlers);
    expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
      "disabled",
      false,
    );
    again({ link: { ...ONLINE, state: "offline" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await settle();
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it("drops the answer of a create that lands after it, and asks the host for nothing more", async () => {
    const answer = deferred<DeviceShift>();
    const handlers = handlersOf({ create: () => answer.promise });
    const { work } = await toTheForm(handlers);
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Новая смена" })).toBeTruthy();
    answer.resolve(PLANNED);
    await settle();
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(types(handlers)).not.toContain("work_entered");
    expect(screen.queryByRole("button", { name: WORK_BUTTON })).toBeNull();
    expect(screen.getByRole("button", { name: "Новая смена" })).toBeTruthy();
    void work;
  });

  it("drops the answer of an entry that lands after it, and shows no work", async () => {
    const answer = deferred<EnteredShift>();
    const handlers = handlersOf({ create: madeAsAsked, enter: () => answer.promise });
    const { work } = await toTheForm(handlers);
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.enter).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByRole("button", { name: "Новая смена" })).toBeTruthy();
    answer.resolve(OPENED);
    await settle();
    expect(types(handlers)).not.toContain("work_entered");
    expect(screen.queryByRole("button", { name: WORK_BUTTON })).toBeNull();
    expect(screen.getByRole("button", { name: "Новая смена" })).toBeTruthy();
    void work;
  });

  it("opens the shift it made into its work screen when nobody went back", async () => {
    const handlers = handlersOf({ create: madeAsAsked });
    await toTheForm(handlers);
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(await screen.findByRole("button", { name: WORK_BUTTON })).toBeTruthy();
    expect(handlers.dispatch).toHaveBeenCalledWith({
      type: "work_entered",
      sessionId: 1,
      shiftId: PLANNED.id,
    });
  });

  it("takes a scan of the floor's scanner as the product, and a refused key to the shell", async () => {
    const local = await floorCopies([OPERATOR, ...CATALOG]);
    const scanner = fakeSource();
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const handlers = handlersOf({ create: () => Promise.reject(refused) });
    render(floorOf(local, handlers, { source: scanner.source }));
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read("4600682000013");
    await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() =>
      expect(handlers.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    expect(types(handlers)).not.toContain("work_entered");
  });
});

describe("what a leave that waits for the work ends in", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("can be asked again for a shift entered a second time, and a third", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    await enterPlanned();
    for (const round of [1, 2, 3]) {
      fireEvent.click(await screen.findByRole("button", { name: "Выйти из смены" }));
      fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
      await waitFor(() =>
        expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(round),
      );
    }
    expect(types(handlers).filter((type) => type === "work_entered")).toHaveLength(4);
    expect(await screen.findByRole("button", { name: "Выйти из смены" })).toBeTruthy();
  });

  it("is a sign-out when the idle wait runs out meanwhile (the idle lock fires once)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { work, handlers } = await inTheWork({ idleTimeoutMs: 30_000 });
    fireEvent.click(screen.getByRole("button", { name: WORK_BUTTON }));
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_500);
    });
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("idle"));
    expect(types(handlers)).toContain("work_left");
    // The shell hears the work end before the sign-out, and the operator is not left on the list.
    expect(handlers.dispatch.mock.invocationCallOrder.at(-1) ?? 0).toBeLessThan(
      handlers.onSignOut.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();
  });

  it("is a sign-out when the host turned the operator off meanwhile", async () => {
    const { local, work, handlers, again } = await inTheWork();
    fireEvent.click(screen.getByRole("button", { name: WORK_BUTTON }));
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
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
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("is a sign-out for another line too, once the work is done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { work, handlers, again } = await inTheWork({ idleTimeoutMs: 30_000 });
    again({ lineChangePending: true });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_500);
    });
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("idle"));
  });

  it("stays the first sign-out when another one comes meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { local, work, handlers, again } = await inTheWork({ idleTimeoutMs: 30_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_500);
    });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
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
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("idle"));
    await settle();
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
  });

  it("leaves for another line once the work is done, whatever the office did to the shift meanwhile", async () => {
    const { local, work, handlers, again } = await inTheWork();
    await officeCloses(local, SEEN + 1);
    again({ shiftReads: { done: 2, failed: false } });
    await waitFor(() => expect(work.officeClosed.at(-1)).toBe(true));
    expect(work.leaving.at(-1)).toBe(false);
    again({ shiftReads: { done: 2, failed: false }, lineChangePending: true });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    await settle();
    await work.release();
    expect(await screen.findByRole("button", { name: "Завершить" })).toBeTruthy();
    expect(types(handlers)).toContain("work_left");
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("leaves to the list, where the shift waits to be finished, when the office closes it after the operator asked to leave", async () => {
    const { local, work, handlers, again } = await inTheWork();
    fireEvent.click(screen.getByRole("button", { name: WORK_BUTTON }));
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    // The plain leave waits for the work; the office's close lands meanwhile.
    await officeCloses(local, SEEN + 1);
    again({ shiftReads: { done: 2, failed: false } });
    await settle();
    await work.release();
    expect(await screen.findByRole("button", { name: "Завершить" })).toBeTruthy();
    await settle();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("leaves for another line, the shift waiting to be finished, when the office closes it after the move to another line began to wait", async () => {
    const { local, work, handlers, again } = await inTheWork();
    again({ lineChangePending: true });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    await officeCloses(local, SEEN + 1);
    again({ lineChangePending: true, shiftReads: { done: 2, failed: false } });
    await settle();
    await work.release();
    expect(await screen.findByRole("button", { name: "Завершить" })).toBeTruthy();
    await settle();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("keeps a sign-out that waits as it is when the office closes the shift meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { local, work, handlers, again } = await inTheWork({ idleTimeoutMs: 30_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_500);
    });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    await officeCloses(local, SEEN + 1);
    again({ shiftReads: { done: 2, failed: false } });
    await settle();
    await work.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("idle"));
    await settle();
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
  });

  it("finishes one leave for two presses of «Выйти из смены» in one turn", async () => {
    const { work, handlers } = await inTheWork();
    const button = screen.getByRole("button", { name: WORK_BUTTON });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    expect(types(handlers)).not.toContain("work_left");
    await work.release();
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    await settle();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("ends on the list, not on a work screen the shell no longer holds, when the move to another line is undone", async () => {
    const { work, handlers, again } = await inTheWork();
    again({ lineChangePending: true });
    await waitFor(() => expect(work.leaving.at(-1)).toBe(true));
    // The office put the station back on its line while the work ran.
    again({ lineChangePending: false });
    await settle();
    expect(screen.queryByRole("button", { name: "Продолжить" })).toBeNull();
    await work.release();
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: WORK_BUTTON })).toBeNull();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("leaves on the list at once outside the work, whatever the reason, and never tells the shell of work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const local = await floorCopies([OPERATOR, ...CATALOG]);
    const handlers = handlersOf();
    render(floorOf(local, handlers, { idleTimeoutMs: 30_000 }));
    fireEvent.click(await screen.findByRole("button", { name: "Новая смена" }));
    await screen.findByText("Новая смена", { selector: "h2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_500);
    });
    expect(handlers.onSignOut).toHaveBeenCalledWith("idle");
    expect(types(handlers)).not.toContain("work_left");
    expect(types(handlers)).not.toContain("work_entered");
  });
});

describe("the shift's copy read after every read of the host's list", () => {
  it("drops a read that lands after the operator left the shift", async () => {
    const real = await floorCopies();
    const gate = gatedExecutor(real);
    const handlers = handlersOf();
    const view = render(floorOf(gate.local, handlers, { workScreen: IdleWork }));
    await enterPlanned();
    await screen.findByText("Смена OCT26-005/S");
    gate.hold();
    view.rerender(
      floorOf(gate.local, handlers, {
        workScreen: IdleWork,
        shiftReads: { done: 2, failed: false },
      }),
    );
    await settle();
    await officeCloses(real, SEEN + 1);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из смены" }));
    await settle();
    gate.release();
    await settle();
    await settle();
    expect(types(handlers).filter((type) => type === "work_left")).toHaveLength(1);
  });

  it("does not take the operator out of a shift the office closed while this station is closing it", async () => {
    const { local, work, handlers, again } = await inTheWork();
    await officeCloses(local, SEEN + 1);
    await closeLocally(local, "closing");
    again({ shiftReads: { done: 2, failed: false } });
    await settle();
    expect(screen.getByRole("button", { name: WORK_BUTTON })).toBeTruthy();
    expect(work.leaving.at(-1)).toBe(false);
    // The station's own close is the one that counts: no «closed in the office» on the screen.
    expect(work.officeClosed.at(-1)).toBe(false);
    expect(types(handlers)).not.toContain("work_left");
  });

  it("stays in the shift when its copy cannot be found, and says nothing", async () => {
    const { local, work, handlers, again } = await inTheWork();
    await local.transaction([
      {
        sql: "DELETE FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ?",
        values: [HOST_ID, DEVICE_ID, PLANNED.id],
        expectedChanges: 1,
      },
    ]);
    again({ shiftReads: { done: 2, failed: false } });
    await settle();
    expect(screen.getByRole("button", { name: WORK_BUTTON })).toBeTruthy();
    expect(work.leaving.at(-1)).toBe(false);
    expect(types(handlers)).not.toContain("work_left");
  });

  it("stays in the shift when its copy cannot be read, and reads it again after the next read of the host", async () => {
    const real = await floorCopies();
    let broken = false;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        broken ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    const handlers = handlersOf();
    const view = render(floorOf(flaky, handlers));
    await enterPlanned();
    await screen.findByText("Смена OCT26-005/S");
    broken = true;
    view.rerender(floorOf(flaky, handlers, { shiftReads: { done: 2, failed: false } }));
    await settle();
    expect(screen.getByText("Смена OCT26-005/S")).toBeTruthy();
    expect(types(handlers)).not.toContain("work_left");
    broken = false;
    await officeCloses(real, SEEN + 1);
    view.rerender(floorOf(flaky, handlers, { shiftReads: { done: 3, failed: false } }));
    expect(await screen.findByText("Смену закрыли в офисе")).toBeTruthy();
  });
});

describe("the operator the copies hold, read after every sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps an operator the copies hold, and refreshes nothing they do not say", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
  });

  it("signs the operator out once the copies no longer hold them", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies([]), handlers));
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
    expect(types(handlers)).not.toContain("operator_refreshed");
  });

  it("keeps the operator when the copies cannot be read", async () => {
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    const handlers = handlersOf();
    render(floorOf(failing, handlers));
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(types(handlers)).not.toContain("operator_refreshed");
  });

  it("reads nothing before the first sync of this run", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies([]), handlers, { sync: { ...SYNCED, synced: 0 } }));
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(types(handlers)).not.toContain("operator_refreshed");
  });

  it("checks again after every later sync, and signs out once", async () => {
    const local = await floorCopies();
    const handlers = handlersOf();
    const view = render(floorOf(local, handlers));
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
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
    view.rerender(floorOf(local, handlers, { sync: { ...SYNCED, synced: 2 } }));
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
    await settle();
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
  });

  it("signs out an operator whose newer record waits in quarantine", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [OPERATOR] }),
      local: executor,
      ...PAIRING,
    });
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(ANNA.id);
    const handlers = handlersOf();
    render(floorOf(executor, handlers));
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
  });

  it("drops a check that lands after the floor is gone", async () => {
    const gate = gatedExecutor(await floorCopies([]));
    gate.hold();
    const handlers = handlersOf();
    const view = render(floorOf(gate.local, handlers));
    view.unmount();
    gate.release();
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(types(handlers)).not.toContain("operator_refreshed");
  });

  it("drops a check that a newer sync has replaced", async () => {
    const gate = gatedExecutor(await floorCopies([]));
    gate.hold();
    const handlers = handlersOf();
    const view = render(floorOf(gate.local, handlers));
    view.rerender(floorOf(gate.local, handlers, { sync: { ...SYNCED, synced: 2 } }));
    gate.release();
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalled());
    // Both checks read the same copies, but only the newer one may answer.
    await settle();
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
  });

  it("signs nobody out on a failed read, says nothing of it, and reads again after the next sync", async () => {
    const quiet = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const real = await floorCopies([]);
    let broken = true;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        broken ? Promise.reject(new Error("disk-secret")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    const handlers = handlersOf();
    const view = render(floorOf(flaky, handlers));
    await settle();
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    expect(screen.queryByText(/disk-secret/)).toBeNull();
    broken = false;
    view.rerender(floorOf(flaky, handlers, { sync: { ...SYNCED, synced: 2 } }));
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith("removed"));
    for (const spy of quiet) expect(spy).not.toHaveBeenCalled();
  });

  it("shows the operator's name as text, whatever characters it holds", async () => {
    const name = '<img src="x" alt="boom"> Анна & <b>Кузнецова</b>';
    const handlers = handlersOf();
    const view = render(
      <ThemeProvider>
        <FloorApp
          operator={{ ...SESSION, name }}
          local={await floorCopies()}
          device={DEVICE_STATUS}
          link={ONLINE}
          sync={{ ...SYNCED, synced: 0 }}
          shiftReads={{ done: 1, failed: false }}
          lineChangePending={false}
          rejectionPending={false}
          enter={handlers.enter}
          create={handlers.create}
          checkCode={handlers.checkCode}
          requestBlock={handlers.requestBlock}
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
    expect(await screen.findByText(`Вошёл: ${name}, табельный номер 0042.`)).toBeTruthy();
    expect(view.container.querySelector("img, b")).toBeNull();
  });
});

describe("the operator as the copies have them", () => {
  const context = (local: LocalExecutor, deviceId = DEVICE_ID) => ({
    local,
    pairing: { hostId: HOST_ID, deviceId },
    now: () => SEEN,
  });

  it("names the operator's name and role, a role the office left empty included", async () => {
    const local = await synced([OPERATOR]);
    expect(await readOperatorCopy(context(local), ANNA.id)).toEqual({
      kind: "present",
      name: ANNA.name,
      role: ANNA.role,
    });
    const roleless = await synced([
      { ...OPERATOR, data: { ...(OPERATOR.data as object), role: null } },
    ]);
    expect(await readOperatorCopy(context(roleless), ANNA.id)).toEqual({
      kind: "present",
      name: ANNA.name,
      role: null,
    });
  });

  it("says absent for an operator the copies do not hold, a deleted one and one in quarantine", async () => {
    const { db, executor } = openLocalDb();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [OPERATOR] }),
      local: executor,
      ...PAIRING,
    });
    expect(
      await readOperatorCopy(context(executor), "00000000-0000-4000-8000-000000000000"),
    ).toEqual({
      kind: "absent",
    });
    db.prepare(
      "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) " +
        "VALUES ('operators', ?, 9, 'data: unrecognized_keys', 1790000000000)",
    ).run(ANNA.id);
    expect(await readOperatorCopy(context(executor), ANNA.id)).toEqual({ kind: "absent" });
  });

  it("says unknown while the copies are not this pairing's", async () => {
    const { executor } = openLocalDb();
    expect(await readOperatorCopy(context(executor), ANNA.id)).toEqual({ kind: "unknown" });
    const local = await synced([OPERATOR]);
    expect(
      await readOperatorCopy(context(local, "00000000-0000-4000-8000-000000000001"), ANNA.id),
    ).toEqual({ kind: "unknown" });
  });
});

describe("what the floor gives the screens it holds", () => {
  it("gives the work screen the session, the pairing, the database, the link and a stable gate", async () => {
    const local = await floorCopies();
    const work = holdingWork();
    const view = render(floorOf(local, handlersOf(), { workScreen: work.Work }));
    await enterPlanned();
    await work.tracked();
    const first = work.seen.at(-1);
    expect(first).toMatchObject({
      operator: SESSION,
      pairing: PAIRING,
      online: true,
      leaving: false,
      shift: { copy: { id: PLANNED.id, number: "OCT26-005/S" } },
    });
    expect(first?.local).toBe(local);
    expect(first?.shift.snapshot.product.name).toBe("Молоко 3,2% 0,9 л");
    view.rerender(
      floorOf(local, handlersOf(), {
        workScreen: work.Work,
        link: { ...ONLINE, state: "offline" },
      }),
    );
    await waitFor(() => expect(work.seen.at(-1)?.online).toBe(false));
    // The gate and the touch are the session's, not new ones with every render.
    expect(work.seen.at(-1)?.track).toBe(first?.track);
    expect(work.seen.at(-1)?.touch).toBe(first?.touch);
    view.rerender(floorOf(local, handlersOf(), { workScreen: work.Work, link: null }));
    await waitFor(() => expect(work.seen.at(-1)?.online).toBe(false));
  });

  it("shows no shifts, and does not fail, for a device without a line", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers, { device: { ...DEVICE_STATUS, lineId: null } }));
    expect(
      await screen.findByText(
        "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Открыть" })).toBeNull();
  });

  it("opens no shift and creates none without the link, and says so", async () => {
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers, { link: { ...ONLINE, state: "offline" } }));
    const open = await screen.findByRole("button", { name: "Открыть" });
    expect(open).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", true);
    fireEvent.click(open);
    await settle();
    expect(handlers.enter).not.toHaveBeenCalled();
  });

  it("waits ten minutes for the idle sign-out by default, not less", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const handlers = handlersOf();
    render(floorOf(await floorCopies(), handlers));
    await screen.findByRole("button", { name: "Открыть" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPERATOR_IDLE_TIMEOUT_MS - 2_000);
    });
    expect(handlers.onSignOut).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(handlers.onSignOut).toHaveBeenCalledWith("idle");
  });

  it("hands a refused device key or another certificate from an entry to the shell, once", async () => {
    const refused = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const first = handlersOf({ enter: () => Promise.reject(refused) });
    const view = render(floorOf(await floorCopies(), first));
    await enterPlanned();
    await waitFor(() =>
      expect(first.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "key_rejected",
      }),
    );
    expect(types(first)).not.toContain("work_entered");
    view.unmount();
    const changed = new HostError({
      kind: "transport",
      code: "certificate_mismatch",
      message: "other",
    });
    const second = handlersOf({ enter: () => Promise.reject(changed) });
    render(floorOf(await floorCopies(), second));
    await enterPlanned();
    await waitFor(() =>
      expect(second.dispatch).toHaveBeenCalledWith({
        type: "device_rejected",
        reason: "host_changed",
      }),
    );
    expect(types(second).filter((type) => type === "device_rejected")).toHaveLength(1);
  });
});

describe("the leave button and the wait of the work screen", () => {
  async function props(over: Partial<WorkScreenProps> = {}): Promise<WorkScreenProps> {
    const { executor } = openLocalDb();
    return {
      shift: await enteredShift(executor),
      operator: SESSION,
      pairing: PAIRING,
      local: executor,
      online: false,
      track: (work) => work,
      touch: () => undefined,
      onLeave: () => undefined,
      leaving: false,
      source: SILENT_SOURCE,
      checkCode: async (): Promise<CodeCheck> => ({ status: "free" }),
      requestBlock: async (): Promise<SsccBlock> => {
        throw new Error("a screen offline asks for no block");
      },
      onHostError: () => undefined,
      onRecorded: () => undefined,
      signal: () => undefined,
      printing: createPrintRuntime(fakeHardware().hardware.printBytes),
      awake: createSystemAwake(async () => undefined),
      ...over,
    };
  }

  it("keeps a live region on the screen from the start, and puts the wait into it", async () => {
    const first = await props();
    const view = render(
      <ThemeProvider>
        <WorkScreen {...first} />
      </ThemeProvider>,
    );
    const region = view.container.querySelector(".work-screen__leaving");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
    view.rerender(
      <ThemeProvider>
        <WorkScreen {...first} leaving />
      </ThemeProvider>,
    );
    expect(view.container.querySelector(".work-screen__leaving")).toBe(region);
    expect(region?.textContent).toBe("Дожидаемся окончания начатой работы…");
    await settle();
  });

  it("asks to leave once, with a 64 px button that the wait does not disable", async () => {
    const onLeave = vi.fn();
    const first = await props({ onLeave });
    const view = render(
      <ThemeProvider>
        <WorkScreen {...first} />
      </ThemeProvider>,
    );
    const leave = screen.getByRole("button", { name: "Выйти из смены" });
    expect(leave.className).toContain("mk-btn--floor");
    expect(leave).toHaveProperty("disabled", false);
    expect(leave.getAttribute("aria-disabled")).toBeNull();
    leave.focus();
    fireEvent.click(leave);
    expect(onLeave).toHaveBeenCalledTimes(1);
    view.rerender(
      <ThemeProvider>
        <WorkScreen {...first} leaving />
      </ThemeProvider>,
    );
    // The same button with the focus still on it: a disabled one drops the
    // focus onto the page, and a keyboard or a screen reader loses its place.
    const waiting = screen.getByRole("button", { name: "Выйти из смены" });
    expect(waiting).toBe(leave);
    expect(document.activeElement).toBe(leave);
    expect(waiting).toHaveProperty("disabled", false);
    expect(waiting.getAttribute("aria-disabled")).toBe("true");
    // Pressing it while the leave waits asks for nothing more.
    fireEvent.click(waiting);
    expect(onLeave).toHaveBeenCalledTimes(1);
    await settle();
  });
});
