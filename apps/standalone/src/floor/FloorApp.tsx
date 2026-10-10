import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import {
  shellActionFor,
  type FloorNotice,
  type FloorSession,
  type ShellAction,
  type SyncState,
} from "../app/shell.js";
import type {
  CodeCheck,
  DeviceShift,
  DeviceShiftCreate,
  DeviceStatus,
  EnteredShift,
  HostStatus,
  SsccBlock,
  SsccBlockRequest,
} from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import { createOperatorIdleLock, OPERATOR_IDLE_TIMEOUT_MS } from "./idle-lock.js";
import type { ScanSource } from "./scan-source.js";
import { NewShift } from "./shifts/NewShift.js";
import { readShiftCopy, type WorkShift } from "./shifts/shift-copies.js";
import { ShiftList, type ShiftListNotice } from "./shifts/ShiftList.js";
import { readOperatorCopy } from "./sign-in.js";
import { createWorkGate } from "./work-gate.js";
import { WorkScreen, type WorkScreenProps } from "./work/WorkScreen.js";

/** Why the operator leaves the shift: back to the list, the office closed it, a sign-out, another line. */
type Leave =
  | { kind: "list"; notice: ShiftListNotice | null }
  | { kind: "sign_out"; notice: FloorNotice | null }
  | { kind: "line_changed" };

type FloorView =
  | { kind: "list"; notice: ShiftListNotice | null }
  | { kind: "new_shift" }
  | { kind: "work"; shift: WorkShift; leaving: boolean };

export interface FloorAppProps {
  operator: FloorSession;
  local: LocalExecutor;
  /** The pairing and the station's line. */
  device: DeviceStatus;
  link: HostStatus | null;
  sync: SyncState;
  /** `ShellState.shiftReads`. */
  shiftReads: { done: number; failed: boolean };
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
  /** The link's delivery of the outbox, asked after every local write (`useHostLink`). */
  requestFacts: () => void;
  /** The floor's scanner: a new shift's product is chosen by a scan. */
  source: ScanSource;
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
 * the line and the work screen of the one entered, as a small machine of its
 * own like the cloud station's. It belongs to one session (`App` keys it by
 * the session), so nothing of one operator's screen outlives their sign-out.
 *
 * Leaving the shift — back to the list, a sign-out (the operator's own, idle,
 * removed by the host), the office's close of the shift, another line — waits
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
  lineChangePending,
  rejectionPending,
  enter,
  create,
  checkCode,
  requestBlock,
  requestFacts,
  source,
  idleTimeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
  workScreen: Work = WorkScreen,
  dispatch,
  onSignOut,
}: FloorAppProps) {
  const { hostId, deviceId, lineId } = device;
  const { sessionId } = operator;
  // A refusal that waits for the operator stops the link: nothing more goes to that host.
  const online = link?.state === "online" && !rejectionPending;
  const [view, setView] = useState<FloorView>({ kind: "list", notice: null });
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

  const finish = useCallback((leave: Leave) => {
    if (leave.kind === "sign_out") {
      current.current.onSignOut(leave.notice);
      return;
    }
    // Back to the list, also after another line: `work_left` already moved the
    // station and ended the session, which takes this floor away, unless the
    // office moved the station back meanwhile. The shell then no longer holds
    // the operator in a shift, and the screen must not show one.
    setView({ kind: "list", notice: leave.kind === "list" ? leave.notice : null });
  }, []);

  /** Leaves the work (or, outside it, the floor) once its tracked work has settled. */
  const leave = useCallback(
    (reason: Leave) => {
      if (current.current.view.kind !== "work") {
        finish(reason);
        return;
      }
      const waiting = standing.current;
      if (waiting !== null) {
        // A sign-out outranks the leave that waits (the idle lock fires once
        // and then waits for nothing more): it is where that leave ends. The
        // office's close of the shift outranks a leave to the list without a
        // reason or to another line, which would otherwise end without saying
        // why the shift is gone.
        if (reason.kind === "sign_out" && waiting.kind !== "sign_out") {
          standing.current = reason;
        } else if (
          reason.kind === "list" &&
          reason.notice !== null &&
          (waiting.kind === "line_changed" || (waiting.kind === "list" && waiting.notice === null))
        ) {
          standing.current = reason;
        }
        return;
      }
      standing.current = reason;
      setView((now) => (now.kind === "work" ? { ...now, leaving: true } : now));
      void gate.drain().then(() => {
        const ending = standing.current ?? reason;
        standing.current = null;
        if (!alive.current) return;
        current.current.dispatch({ type: "work_left", sessionId });
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
  // operator works in it takes them back to the list.
  const workShiftId = view.kind === "work" ? view.shift.copy.id : null;
  useEffect(() => {
    if (workShiftId === null || shiftReads.done === 0) return;
    let cancelled = false;
    readShiftCopy(local, { hostId, deviceId }, workShiftId).then(
      (copy) => {
        if (cancelled || copy === null) return;
        if (copy.status === "closed" && copy.localState === null) {
          leave({ kind: "list", notice: { kind: "office_closed", number: copy.number } });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, workShiftId, shiftReads.done, leave]);

  // Another line waits for the work (question В9): leave the shift for it.
  useEffect(() => {
    if (lineChangePending && workShiftId !== null) leave({ kind: "line_changed" });
  }, [lineChangePending, workShiftId, leave]);

  const entered = useCallback(
    (shift: WorkShift) => {
      const { copy } = shift;
      // An entry's late answer can land on a shift the office has closed since
      // (the copy reads back `closed`), or one this station is closing: no work
      // screen, and so no scan, for it. The shell is not told of work.
      if (copy.status !== "active" || copy.localState !== null) {
        const officeClosed = copy.status === "closed" && copy.localState === null;
        setView({
          kind: "list",
          notice: officeClosed ? { kind: "office_closed", number: copy.number } : null,
        });
        setTurnedBack((times) => times + 1);
        return;
      }
      current.current.dispatch({ type: "work_entered", sessionId, shiftId: copy.id });
      setView({ kind: "work", shift, leaving: false });
    },
    [sessionId],
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
        onLeave={() => leave({ kind: "list", notice: null })}
        source={source}
        checkCode={checkCode}
        requestBlock={requestBlock}
        onHostError={hostError}
        onRecorded={recorded}
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
        onBack={() => setView({ kind: "list", notice: null })}
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
      notice={view.notice}
      enter={enter}
      onEntered={entered}
      onHostError={hostError}
      onNew={() => setView({ kind: "new_shift" })}
      onSignOut={() => leave({ kind: "sign_out", notice: null })}
    />
  );
}
