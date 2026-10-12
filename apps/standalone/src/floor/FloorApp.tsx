import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import type { SignalTone } from "@markiro/ui";

import {
  shellActionFor,
  type FloorNotice,
  type FloorSession,
  type ShellAction,
  type SyncState,
} from "../app/shell.js";
import type {
  WarehouseLookup,
  WarehouseLookupResult,
  CodeCheck,
  DeviceShift,
  DeviceShiftCreate,
  DeviceStatus,
  EnteredShift,
  HostStatus,
  SsccBlock,
  SsccBlockRequest,
} from "../host/protocol.js";
import type { SystemAwake } from "../hardware/awake.js";
import type { HardwareApi } from "../hardware/hardware.js";
import type { LocalExecutor } from "../local/executor.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import type { RenderLabel } from "./print/print-jobs.js";
import type { PrintRuntime } from "./print/print-runtime.js";
import type { ScanSource } from "./scan-source.js";
import { WorkstationSetup } from "./setup/WorkstationSetup.js";
import {
  DEFAULT_SOUND,
  readWorkstationSettings,
  soundLevel,
} from "./setup/workstation-settings.js";
import { NewShift } from "./shifts/NewShift.js";
import { readShiftCopy, readStoredWork, type WorkShift } from "./shifts/shift-copies.js";
import { QueueScreen } from "./queue/QueueScreen.js";
import { ShiftList } from "./shifts/ShiftList.js";
import { readOperatorCopy } from "./sign-in.js";
import { createWorkGate } from "./work-gate.js";
import { playSignalTone } from "./work/signal-sound.js";
import { WarehouseScreen } from "./warehouse/WarehouseScreen.js";
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";

/**
 * Why the operator leaves the shift: back to the list, a sign-out, another
 * line, or the workstation setup from a label's recovery (plan 2a7), which
 * comes back to the shift. A shift the office closed is no reason: it is
 * finished on the work screen (plan 2a8).
 */
type Leave =
  | { kind: "list" }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" }
  | { kind: "setup"; shift: WorkShift }
  // From the warehouse reprint to the workstation setup, and back to its session (plan СКЛ).
  | { kind: "warehouse_setup" };

/**
 * The floor's screens; in the work of a shift, `officeClosed` says the
 * office closed the shift after this station entered it (plan 2a8).
 */
type FloorView =
  | { kind: "list" }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean; officeClosed: boolean }
  // The warehouse reprint (plan СКЛ): no shift, its work gated like a shift's.
  | { kind: "warehouse"; leaving: boolean }
  | { kind: "setup"; back: WorkShift | "warehouse" | null }
  // The queue of what was not sent (plan ОЧ).
  | { kind: "queue" };

export interface FloorAppProps {
  operator: FloorSession;
  local: LocalExecutor;
  /** The pairing and the station's line. */
  device: DeviceStatus;
  link: HostStatus | null;
  sync: SyncState;
  /** `ShellState.shiftReads`. */
  shiftReads: { done: number; failed: boolean };
  /** `ShellState.outboxVersion`: the list reads its copies again after every write and receipt. */
  outboxVersion?: number;
  /** The office moved the station to another line, and the move waits for the work (`pendingDevice`). */
  lineChangePending: boolean;
  /**
   * The host refused this device, or another host answers at its address, while
   * the operator works (`pendingRejection`, `pendingOtherHost`; question В8):
   * the link is stopped, and the work screen asks the host nothing.
   */
  rejectionPending: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
  /** `HostApi.createDeviceShift`. */
  create: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  /** `HostApi.checkCode`: the work screen's check of a code on the host. */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /** `HostApi.requestSsccBlock`: the work screen's serials for its boxes. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** `HostApi.warehouseLookup` (plan СКЛ); none — the list offers no warehouse reprint. */
  warehouseLookup?: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  /** The link's delivery of the outbox, asked after every local write (`useHostLink`). */
  requestFacts: () => void;
  /** The floor's scanner: a new shift's product is chosen by a scan. */
  source: ScanSource;
  /** The app's printers (plan 2a7). */
  printing: PrintRuntime;
  /** The shell's printers and scanners, for the workstation setup. */
  hardware: HardwareApi;
  /** Keeps the computer awake while a work screen is open. */
  awake: SystemAwake;
  /** How a label is rendered; tests give their own. */
  render?: RenderLabel;
  /** Nobody touched the station this long: the operator is signed out. */
  idleTimeoutMs?: number;
  /** The work screen of a shift; tests give their own. */
  workScreen?: ComponentType<WorkScreenProps>;
  dispatch: (action: ShellAction) => void;
  /** `null` is the operator's own «Сменить оператора». */
  onSignOut: (notice: FloorNotice | null) => void;
}

/**
 * The floor after an operator signed in (stage 2a spec §5.1): the shifts of
 * the line, the queue of what was not sent (plan ОЧ) and the work screen of the
 * one entered, as a small machine of its
 * own like the cloud station's. It belongs to one session (`App` keys it by
 * the session), so nothing of one operator's screen outlives their sign-out.
 *
 * Leaving the shift — back to the list, a sign-out (the operator's own, idle,
 * removed by the host), another line — waits
 * for the work the screen tracks (`createWorkGate`), then tells the shell
 * (`work_left`), which is when a refusal of this device or a line change that
 * waited for the work takes the floor. The idle wait and the check of the
 * operator after a sync run for the whole session; the check also brings a
 * new name or role (`operator_refreshed`), without a new session.
 */
export function FloorApp({
  operator,
  local,
  device,
  link,
  sync,
  shiftReads,
  outboxVersion = 0,
  lineChangePending,
  rejectionPending,
  enter,
  create,
  checkCode,
  requestBlock,
  warehouseLookup,
  requestFacts,
  source,
  printing,
  hardware,
  awake,
  render,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
  workScreen: Work = WorkScreen,
  dispatch,
  onSignOut,
}: FloorAppProps) {
  const { hostId, deviceId, lineId } = device;
  const { sessionId } = operator;
  // A refusal that waits for the operator stops the link: nothing more goes to that host.
  const online = link?.state === "online" && !rejectionPending;
  const [view, setView] = useState<FloorView>({ kind: "list" });
  // How many times an entry was turned back on the list: it reads its copies
  // again, for those it showed are the ones the entry found out of date.
  const [turnedBack, setTurnedBack] = useState(0);
  // One gate for the life of the floor: `useMemo` may be recomputed, a state is kept.
  const [gate] = useState(createWorkGate);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The view and the callbacks as the last commit has them, for timers and
  // answers that land later.
  const current = useRef({ view, onSignOut, dispatch });
  useLayoutEffect(() => {
    current.current = { view, onSignOut, dispatch };
  });
  // What the leave that waits for the work ends in; `null` when none waits.
  const standing = useRef<Leave | null>(null);
  // True from the moment a leave from a shift's work is asked for until the
  // next shift is entered. The render's `leaving` lags behind a leave that a
  // timer or an answer started, and a scan taken in between would be written
  // after the gate had drained; the work screen asks this at once.
  const ending = useRef(false);
  const isLeaving = useCallback(() => ending.current, []);

  const finish = useCallback((leave: Leave) => {
    if (leave.kind === "sign_out") {
      current.current.onSignOut(leave.notice);
      return;
    }
    // Back to the list, also after another line: `work_left` already moved the
    // station and ended the session, which takes this floor away, unless the
    // office moved the station back meanwhile. The shell then no longer holds
    // the operator in a shift, and the screen must not show one.
    if (leave.kind === "setup") {
      setView({ kind: "setup", back: leave.shift });
      return;
    }
    if (leave.kind === "warehouse_setup") {
      setView({ kind: "setup", back: "warehouse" });
      return;
    }
    setView({ kind: "list" });
  }, []);

  /** Leaves the work (or, outside it, the floor) once its tracked work has settled. */
  const leave = useCallback(
    (reason: Leave) => {
      const from = current.current.view.kind;
      // The warehouse reprint's work is tracked by the same gate as a shift's (N9),
      // but it is no shift: the shell is told of no work entered or left.
      if (from !== "work" && from !== "warehouse") {
        finish(reason);
        return;
      }
      ending.current = true;
      const waiting = standing.current;
      if (waiting !== null) {
        // A sign-out outranks the leave that waits (the idle lock fires once
        // and then waits for nothing more): it is where that leave ends.
        if (reason.kind === "sign_out" && waiting.kind !== "sign_out") {
          standing.current = reason;
        }
        return;
      }
      standing.current = reason;
      setView((now) =>
        now.kind === "work" || now.kind === "warehouse" ? { ...now, leaving: true } : now,
      );
      void gate.drain().then(() => {
        const ending = standing.current ?? reason;
        standing.current = null;
        if (!alive.current) return;
        if (from === "work") current.current.dispatch({ type: "work_left", sessionId });
        finish(ending);
      });
    },
    [finish, gate, sessionId],
  );

  const idle = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    idle.current = () => leave({ kind: "sign_out", notice: "idle" });
  });
  const lock = useMemo(
    () =>
      createOperatorIdleLock({
        target: window,
        timeoutMs: idleTimeoutMs,
        onIdle: () => idle.current(),
      }),
    [idleTimeoutMs],
  );
  useEffect(() => {
    lock.start();
    return () => lock.stop();
  }, [lock]);

  // After every sync: the operator the host turned off is signed out; a new
  // name or role is shown. A copy that cannot be read signs nobody out.
  useEffect(() => {
    if (sync.synced === 0) return;
    let cancelled = false;
    readOperatorCopy({ local, pairing: { hostId, deviceId }, now: Date.now }, operator.id).then(
      (copy) => {
        if (cancelled) return;
        if (copy.kind === "absent") leave({ kind: "sign_out", notice: "removed" });
        if (copy.kind === "present") {
          current.current.dispatch({
            type: "operator_refreshed",
            sessionId,
            name: copy.name,
            role: copy.role,
          });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, operator.id, sessionId, sync.synced, leave]);

  // After every read of the host's list: a shift the office closed while the
  // operator works in it stays on screen to be finished (plan 2a8) — the box
  // on the line closes with its label, and the station closes the shift —
  // but it takes no new code. Leaving at once would strand the box and its
  // label; the host takes what follows and marks the shift late.
  const workShiftId = view.kind === "work" ? view.shift.copy.id : null;
  useEffect(() => {
    if (workShiftId === null || shiftReads.done === 0) return;
    let cancelled = false;
    readShiftCopy(local, { hostId, deviceId }, workShiftId).then(
      (copy) => {
        if (cancelled || copy === null) return;
        if (copy.status === "closed" && copy.localState === null) {
          setView((now) =>
            now.kind === "work" && now.shift.copy.id === copy.id
              ? { ...now, officeClosed: true }
              : now,
          );
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, workShiftId, shiftReads.done]);

  // Another line waits for the work (question В9): leave the shift for it.
  useEffect(() => {
    if (lineChangePending && workShiftId !== null) leave({ kind: "line_changed" });
  }, [lineChangePending, workShiftId, leave]);

  const entered = useCallback(
    (shift: WorkShift) => {
      const { copy } = shift;
      // An entry's late answer can land on a shift this station is closing, or
      // one that is neither active nor closed by the office: no work screen,
      // and so no scan, for it. The shell is not told of work. A shift the
      // office closed since is entered to be finished, without new codes
      // (plan 2a8).
      if ((copy.status !== "active" && copy.status !== "closed") || copy.localState !== null) {
        setView({ kind: "list" });
        setTurnedBack((times) => times + 1);
        return;
      }
      current.current.dispatch({ type: "work_entered", sessionId, shiftId: copy.id });
      ending.current = false;
      setView({
        kind: "work",
        shift,
        leaving: false,
        officeClosed: copy.status === "closed",
      });
    },
    [sessionId],
  );
  // The level of the verdict tones: the workstation's sound setting, read
  // when the floor opens and again after the setup stores it. The work screen
  // asks it when a tone plays, so a change is heard at once.
  const toneLevel = useRef(soundLevel(DEFAULT_SOUND));
  useEffect(() => {
    let cancelled = false;
    readWorkstationSettings(local).then(
      (settings) => {
        if (!cancelled) toneLevel.current = soundLevel(settings.sound);
      },
      // Unreadable settings keep the default level: the tones stay audible.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local]);
  const signal = useCallback((tone: SignalTone) => {
    playSignalTone(tone, undefined, toneLevel.current);
  }, []);

  // Back from the setup to the shift it was opened from. The shift is read
  // again: the office may have closed it meanwhile, and the setup has no
  // eyes on the host's list. A shift that cannot be read again is left for the list.
  const returning = useRef(false);
  const backFromSetup = useCallback(
    (back: WorkShift | "warehouse" | null) => {
      if (back === null) {
        setView({ kind: "list" });
        return;
      }
      if (back === "warehouse") {
        ending.current = false;
        setView({ kind: "warehouse", leaving: false });
        return;
      }
      if (returning.current) return;
      returning.current = true;
      void readStoredWork(local, { hostId, deviceId }, back.copy.id)
        .then(
          (stored) => (stored.kind === "ready" ? stored.shift : null),
          () => null,
        )
        .then((shift) => {
          returning.current = false;
          if (!alive.current) return;
          if (shift === null) setView({ kind: "list" });
          else entered(shift);
        });
    },
    [local, hostId, deviceId, entered],
  );
  const hostError = useCallback((error: unknown) => {
    const action = shellActionFor(error, null);
    if (action !== null) current.current.dispatch(action);
  }, []);
  // A record written: the status bar reads its counts again, and the outbox goes.
  const recorded = useCallback(() => {
    current.current.dispatch({ type: "outbox_changed" });
    requestFacts();
  }, [requestFacts]);

  if (view.kind === "setup") {
    const { back } = view;
    return (
      <WorkstationSetup
        local={local}
        hardware={hardware}
        printing={printing}
        source={source}
        {...(render === undefined ? {} : { render })}
        onSaved={(settings) => {
          toneLevel.current = soundLevel(settings.sound);
        }}
        // Back to the shift the setup was opened from, or to the list.
        onBack={() => backFromSetup(back)}
      />
    );
  }
  if (view.kind === "work") {
    return (
      <Work
        shift={view.shift}
        operator={operator}
        pairing={{ hostId, deviceId }}
        local={local}
        online={online}
        track={gate.track}
        touch={lock.touch}
        leaving={view.leaving}
        officeClosed={view.officeClosed}
        isLeaving={isLeaving}
        linkHeld={rejectionPending}
        onLeave={() => leave({ kind: "list" })}
        source={source}
        checkCode={checkCode}
        requestBlock={requestBlock}
        onHostError={hostError}
        onRecorded={recorded}
        printing={printing}
        awake={awake}
        signal={signal}
        onSetup={() => leave({ kind: "setup", shift: view.shift })}
        {...(render === undefined ? {} : { render })}
      />
    );
  }
  if (view.kind === "warehouse" && warehouseLookup !== undefined) {
    return (
      <WarehouseScreen
        operator={operator}
        local={local}
        pairing={{ hostId, deviceId }}
        online={online}
        track={gate.track}
        touch={lock.touch}
        isLeaving={isLeaving}
        source={source}
        lookup={warehouseLookup}
        onHostError={hostError}
        onRecorded={recorded}
        printing={printing}
        onLeave={() => leave({ kind: "list" })}
        onSetup={() => leave({ kind: "warehouse_setup" })}
      />
    );
  }
  if (view.kind === "queue") {
    return (
      <QueueScreen
        local={local}
        pairing={{ hostId, deviceId }}
        operator={operator}
        link={link}
        outboxVersion={outboxVersion}
        onChanged={recorded}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }
  if (view.kind === "new_shift") {
    return (
      <NewShift
        local={local}
        pairing={{ hostId, deviceId }}
        online={online}
        source={source}
        create={create}
        enter={enter}
        onEntered={entered}
        onHostError={hostError}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }
  return (
    <ShiftList
      key={turnedBack}
      local={local}
      pairing={{ hostId, deviceId }}
      // Only a station reaches the floor with a line chosen; a device of
      // another kind (none pairs so in stage 2a) sees no shifts, and the host
      // refuses a shift it would create (`shift_line`): never a blank screen.
      lineId={lineId ?? ""}
      operator={operator}
      online={online}
      shiftReads={shiftReads}
      outboxVersion={outboxVersion}
      enter={enter}
      onEntered={entered}
      onHostError={hostError}
      onNew={() => setView({ kind: "new_shift" })}
      onSetup={() => setView({ kind: "setup", back: null })}
      onQueue={() => setView({ kind: "queue" })}
      {...(warehouseLookup === undefined
        ? {}
        : {
            onWarehouse: () => {
              ending.current = false;
              setView({ kind: "warehouse", leaving: false });
            },
          })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
    />
  );
}
