import { formatSsccHri } from "@markiro/domain";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, SignalOverlay, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { SystemAwake } from "../../hardware/awake.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
import {
  boxLabelStep,
  isOpenJob,
  readOpenJob,
  recoverInterruptedJobs,
  sendLabelJob,
  StaleJobError,
  type PrintJob,
  type RenderLabel,
} from "../print/print-jobs.js";
import {
  awaitsCheck,
  checkLabel,
  confirmPrinted,
  LabelRenderError,
  NoPrinterError,
  printAgain,
  skipLabel,
  UnresolvableJobError,
  type PrintAgain,
  type ResolveContext,
} from "../print/print-resolution.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { readWorkstationSettings } from "../setup/workstation-settings.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { formatQuantity } from "../shifts/shift-text.js";
import { createBlockSupply, type BlockContext, type SupplyResult } from "./block-supply.js";
import {
  boxIsFull,
  closeOpenBox,
  readClosedBox,
  type BoxContext,
  type CloseResult,
  type CloseStep,
  type ClosingBox,
} from "./box-close.js";
import { processScan, type ScanContext, type ScanOutcome } from "./scan-pipeline.js";
import { playSignalTone } from "./signal-sound.js";
import { createWorkQueue } from "./work-queue.js";
import { readOpenBox, readWorkTotals, type WorkTotals } from "./work-reads.js";

/**
 * What the floor gives the work screen of a shift (the contract plans 2a6–2a8
 * build on): the shift with the snapshot this build read, the session, the
 * pairing whose rows it writes, the local database and the link; `track`
 * holds the leave until a piece of work settles; `touch` restarts the
 * operator's idle wait (a COM scanner presses no key); `onLeave` asks to go
 * back to the list, which the floor does once the tracked work has settled,
 * and `leaving` says it is waiting for that. Plan 2a6 adds the scanner, the
 * host's code check and blocks, the shell's handling of a refused key, the
 * outbox's delivery after a write, and the extension points of the label's
 * plan (`closeSteps`, `onClosed`).
 *
 * What the screen owes the floor (the floor cannot check it; the tests of
 * this screen do):
 *
 * - Every write to the local database, every send to the host and every job
 *   for the printer is handed to `track` BEFORE it starts, never after: the
 *   leave, a refusal of the device and a move to another line wait for it, and
 *   a piece of work started outside the gate is lost with the shift. A piece
 *   of work is handed to `track` in the turn before the one that starts it
 *   (`Promise.resolve().then(…)`, or a job queued behind another).
 * - No scan is accepted while `leaving`: a scan taken then would start work
 *   the leave no longer waits for. It is refused in words, by tone and by
 *   flash; none is dropped silently. `leaving` comes with a render, which a
 *   leave started by a timer or an answer (the idle lock, the office closing
 *   the shift) may not have had yet: `isLeaving` says it at once, and the
 *   screen asks both.
 * - Tracked work is bounded, because the gate has no timeout of its own that
 *   could let the leave through in the middle of a write: a local write ends in
 *   about 35 s at the most (the busy timeout of 5 s and the wait for the pool
 *   of sqlx, 30 s), a label's send in 20 s from the moment it asks
 *   (`PRINT_SEND_LIMIT_MS`, the wait behind another send of its printer
 *   included) plus its two local writes, the check of a
 *   code at the host in 300 ms, a request for a block in up to two calls of
 *   10 s each (the host client's limit; a request refused as another prefix's
 *   is sent once more, fresh), plus its local writes. Work that can wait
 *   longer than that must not be tracked as one piece.
 * - The way back to the list is a button that stays on the keyboard while the
 *   leave waits: `aria-disabled`, not `disabled`, which drops the focus onto
 *   the page. The waiting is said in a polite region that is on the screen
 *   before it is said.
 * - Every writer of a box — a scan, a close, plan 2a8's exceptions, the
 *   pallets' plan — runs in this screen's queue (`createWorkQueue`): the
 *   digest of a closing box is read apart from the box, and only the queue
 *   keeps a scan and an undo from changing the box between the two reads.
 *   The same goes for every decision on a label and for the recovery of
 *   interrupted sends (`recoverInterruptedJobs`, which must never run beside
 *   a send): the recovery runs once, on entering the screen, and a label is
 *   sent only from a turn of the queue.
 * - Nothing sends a label a second time by itself. The first send of a job
 *   (`prepared`) is the screen's; every later one is the operator's decision
 *   (`printAgain`), with a reason when the label may exist.
 */
export interface WorkScreenProps {
  shift: WorkShift;
  operator: FloorSession;
  pairing: Pairing;
  local: LocalExecutor;
  online: boolean;
  track: <T>(work: Promise<T>) => Promise<T>;
  touch: () => void;
  onLeave: () => void;
  leaving: boolean;
  /**
   * Whether the floor has begun to leave, answered at once (a ref's value, not
   * the render's): true from the moment the leave is asked for until the next
   * shift is entered. Optional; a screen without it goes by `leaving`.
   */
  isLeaving?: () => boolean;
  /**
   * The link to the host is held off for the rest of the shift (a refusal of
   * the device or another host waits for the operator to leave): `online` is
   * false and no serials will come, which the screen says in its own words.
   */
  linkHeld?: boolean;
  /** The floor's scanner: the keyboard and the COM scanners. */
  source: ScanSource;
  /** `HostApi.checkCode` (300 ms). */
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  /** `HostApi.requestSsccBlock`. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** A failed host call the shell may act on: a refused key, another certificate. */
  onHostError: (error: unknown) => void;
  /** A local write: the status bar reads its counts again, and the outbox goes. */
  onRecorded: () => void;
  /** The tone of a verdict; the generated tones by default. */
  signal?: (tone: SignalTone) => void;
  /**
   * The steps of later plans that go into the transaction of EVERY close of a
   * box, after the screen's own (the box's label job, plan 2a7): the pallets'
   * plan's (`CloseStep`, `box-close.ts`). None until that plan passes its.
   */
  closeSteps?: readonly CloseStep[];
  /**
   * Told once for every box that closed, with the box as it was written —
   * also for a box whose close was written but whose answer was lost (read
   * back from `floor_boxes` on the next close). It is told in the queue's
   * turn, after the write; whatever it starts must be handed to `track`
   * before it begins. The box's label is not started from here: the screen
   * settles it in the same turn of the queue, from the shift's print jobs, so
   * a box whose answer was lost and never read back (the operator left first)
   * still has its job, found on the next entry.
   */
  onClosed?: (box: ClosingBox) => void;
  /** The app's printers: one send at a time per address, each within its limit (plan 2a7). */
  printing: PrintRuntime;
  /** Keeps the computer awake while the screen is open (decision 34). */
  awake: SystemAwake;
  /** The workstation setup, from the recovery of a label (plan 2a7); none — no button. */
  onSetup?: () => void;
  /** How a label is rendered; the app's rasterizer by default. */
  render?: RenderLabel;
}

/** What stops the scanning until the operator acts (stage 2a spec §5.7.3). */
type Stop =
  /**
   * `write`: a scan or a close did not reach the database; `read`: the entry
   * could not read it; `label`: a label's job could not be read or written
   * (dismissing it reads the label again).
   */
  | { kind: "system_error"; cause: "write" | "read" | "label" }
  | { kind: "confirm_close" }
  | { kind: "no_serials"; reason: "offline" | "exhausted" | "failed"; full: boolean }
  /**
   * `serial`: the block's serial does not fit (past the prefix's range, or an
   * SSCC a box already holds) and is spent; `write`: the close did not reach
   * the database (a failed write, or three tries that found the box changed).
   */
  | { kind: "close_failed"; full: boolean; cause: "serial" | "write" }
  /** The label of a closed box waits: its check, or its recovery (plan 2a7, spec §5.7.5). */
  | { kind: "label"; job: PrintJob };

/** The last scan, said in words under the box. */
type Last = ScanOutcome | { kind: "paused"; leaving: boolean };

/** How long the coloured flash of a refusal covers the screen (an accepted scan has none). */
export const SIGNAL_MS = 700;

/** How long the last-scan line is lit after an accepted scan. */
export const CUE_MS = 350;

/** How many times a close that found the box or the block changed is tried in all. */
const CLOSE_TRIES = 3;

const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** The time of a scan, on this computer's clock. */
export function scanTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** The last scan in words. */
function lastText(last: Last, t: TFunction, capacity: number): string {
  switch (last.kind) {
    case "accepted":
      return t("floor.work.last.accepted", {
        quantity: formatQuantity(last.itemCount),
        capacity: formatQuantity(capacity),
      });
    case "duplicate":
      return last.source === "local"
        ? t("floor.work.last.duplicateLocal", { time: scanTime(last.firstScannedAt) })
        : t("floor.work.last.duplicateHost", {
            number: last.shiftNumber,
            time: scanTime(last.firstScannedAt),
          });
    case "wrong_gtin":
      return t("floor.work.last.wrongGtin", { gtin: last.gtin14 });
    case "invalid":
      return t(`floor.work.last.invalid.${last.rawKind}`);
    case "paused":
      return t(last.leaving ? "floor.work.last.leaving" : "floor.work.last.paused");
  }
}

/**
 * What a job reads when it runs, later than the render that queued it: the
 * latest props, so that the callbacks of the screen stay the same for its
 * whole life and a new function from the floor starts no second piece of work.
 */
interface Live {
  shift: WorkShift;
  operatorId: string;
  hostId: string;
  deviceId: string;
  local: LocalExecutor;
  online: boolean;
  leaving: boolean;
  isLeaving: (() => boolean) | undefined;
  touch: () => void;
  track: <T>(work: Promise<T>) => Promise<T>;
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  onHostError: (error: unknown) => void;
  onRecorded: () => void;
  signal: (tone: SignalTone) => void;
  closeSteps: readonly CloseStep[];
  onClosed: ((box: ClosingBox) => void) | undefined;
  printing: PrintRuntime;
  operatorName: string;
  render: RenderLabel | undefined;
  t: TFunction;
}

type LiveRef = MutableRefObject<Live>;

function pairingOf(now: Live): Pairing {
  return { hostId: now.hostId, deviceId: now.deviceId };
}

function boxContextOf(live: LiveRef): BoxContext {
  const now = live.current;
  return {
    local: now.local,
    pairing: pairingOf(now),
    shift: now.shift,
    operatorId: now.operatorId,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
}

/** The context of a label's send and of the operator's decisions on it. */
function printContextOf(live: LiveRef): ResolveContext {
  const now = live.current;
  return {
    local: now.local,
    pairing: pairingOf(now),
    runtime: now.printing,
    now: () => new Date(),
    operatorId: now.operatorId,
    newId: () => crypto.randomUUID(),
  };
}

function scanContextOf(live: LiveRef): ScanContext {
  const now = live.current;
  return {
    ...boxContextOf(live),
    online: () => live.current.online,
    checkCode: now.checkCode,
    onHostError: (error) => live.current.onHostError(error),
  };
}

/**
 * The context of the screen's one block supply. It reads everything through
 * `live`, so the supply is made once and never again, whatever the floor
 * gives the screen later (two supplies at once would both write the block).
 */
function blockContextOf(live: LiveRef): BlockContext {
  return {
    get local() {
      return live.current.local;
    },
    get pairing() {
      return pairingOf(live.current);
    },
    get issuerPrefix() {
      return live.current.shift.snapshot.issuerPrefix;
    },
    online: () => live.current.online,
    requestBlock: (request) => live.current.requestBlock(request),
    onHostError: (error) => live.current.onHostError(error),
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
}

/** A close again on `stale` (nothing was written: the box or the block changed meanwhile). */
async function closeSettled(close: () => Promise<CloseResult>): Promise<CloseResult> {
  let result = await close();
  for (let attempt = 1; attempt < CLOSE_TRIES && result.kind === "stale"; attempt += 1) {
    result = await close();
  }
  return result;
}

/** How an attempt to close the box ended, for the screen to act on. */
type CloseOutcome =
  | { kind: "nothing" }
  | { kind: "closed"; box: ClosingBox }
  /** A label that waits keeps the next box open: it is settled instead. */
  | { kind: "label_waits" }
  | { kind: "stop"; stop: Stop };

interface CloseEnv {
  live: LiveRef;
  /** Told while a close waits for the host's serials (true) and when it no longer does. */
  waiting: (waiting: boolean) => void;
  supply: { topUp: () => Promise<SupplyResult> };
  /**
   * The box whose close ended without an answer (the write threw): it may have
   * been committed all the same. Read back on the next close.
   */
  unsure: MutableRefObject<string | null>;
}

/**
 * The box a lost answer left in doubt, read back from the database; `null`
 * when there is none, or the write did not happen after all (the box is open
 * and the normal close deals with it). Kept until the read succeeds.
 */
async function settleUnsure(env: CloseEnv): Promise<ClosingBox | null> {
  const id = env.unsure.current;
  if (id === null) return null;
  const now = env.live.current;
  const box = await readClosedBox(now.local, pairingOf(now), id, now.operatorId);
  env.unsure.current = null;
  return box;
}

/**
 * One attempt to close the shift's open box — the full one (`full`: only once
 * it holds the shift's box capacity) or the one the operator confirmed. The
 * serials running out are asked of the host once and the close tried again; a
 * close that found the box changed is tried up to three times. Whatever is
 * left stops the line (`stop`): a full box that is not closed must never be
 * left to take another code.
 */
async function attemptClose(env: CloseEnv, full: boolean): Promise<CloseOutcome> {
  const now = env.live.current;
  const open = await readOpenBox(now.local, pairingOf(now), now.shift.copy.id);
  if (open === null || open.itemCount === 0) return { kind: "nothing" };
  if (full && !boxIsFull(open.itemCount, now.shift.copy.boxCapacity)) return { kind: "nothing" };
  // A label that waits keeps the next box open (stage 2a spec §5.7.5).
  const waiting = await readOpenJob(now.local, pairingOf(now), now.shift.copy.id);
  if (waiting !== null) return { kind: "label_waits" };
  const close = async (): Promise<CloseResult> => {
    // The box's label job joins the close's own transaction, before the steps of later plans.
    const label = boxLabelStep({
      local: now.local,
      pairing: pairingOf(now),
      shift: now.shift,
      operatorName: now.operatorName,
      newId: () => crypto.randomUUID(),
      ...(now.render === undefined ? {} : { render: now.render }),
    });
    try {
      return await closeOpenBox(boxContextOf(env.live), [label, ...env.live.current.closeSteps]);
    } catch (error) {
      // The write may have been committed, and only its answer lost.
      env.unsure.current = open.id;
      throw error;
    }
  };
  let result = await closeSettled(close);
  let supplied: SupplyResult | null = null;
  if (result.kind === "no_serials") {
    // Said while the host is asked: a close waits here for up to two calls.
    env.waiting(now.online);
    try {
      supplied = await env.supply.topUp();
    } finally {
      env.waiting(false);
    }
    if (supplied.kind === "stored") {
      env.live.current.onRecorded();
      result = await closeSettled(close);
    }
  }
  switch (result.kind) {
    case "closed":
      return { kind: "closed", box: result.box };
    case "empty": {
      // The box was read a moment ago in this same turn of the queue, where
      // nothing else writes a box. It is gone only if an earlier try of this
      // close was written and its answer lost (reported as `stale`): the box
      // is closed, with its job, and goes on as after a close — its label must
      // not be skipped. Otherwise a full box that is neither closed nor held
      // by a stop would take another code: stop.
      const closed = await readClosedBox(now.local, pairingOf(now), open.id, now.operatorId);
      if (closed !== null) return { kind: "closed", box: closed };
      return { kind: "stop", stop: { kind: "close_failed", full, cause: "write" } };
    }
    case "no_serials": {
      const reason =
        supplied === null || supplied.kind === "stored" || supplied.kind === "enough"
          ? "failed"
          : supplied.kind;
      return { kind: "stop", stop: { kind: "no_serials", reason, full } };
    }
    case "invalid_serial":
      return { kind: "stop", stop: { kind: "close_failed", full, cause: "serial" } };
    case "stale":
      return { kind: "stop", stop: { kind: "close_failed", full, cause: "write" } };
  }
}

/**
 * The work screen of a shift (stage 2a spec §5.7.3–5.7.4): scans of the floor's
 * scanner go through the pipeline one at a time (`createWorkQueue`), each
 * handed to the floor's work gate (`track`), so leaving waits for it. A box
 * closes by itself when it holds the shift's capacity, and an incomplete one
 * after the operator confirms; a closed box asks the host for serials by the
 * half rule, as do the entry and the link coming back. While a message stops
 * the work — a failed write, no serials, a close to confirm — or the operator
 * leaves, a scan is not taken and the screen says so: nothing is dropped
 * silently. A full box is closed before the next code is read in the same
 * turn of the queue, so no stop that is lifted lets a box overfill. Every
 * verdict shows in words, as a flash and as a tone.
 */
export function WorkScreen(props: WorkScreenProps) {
  const { shift, leaving, onLeave, source, linkHeld = false } = props;
  const { t } = useTranslation();
  const [totals, setTotals] = useState<WorkTotals | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const [flash, setFlash] = useState<{
    tone: SignalTone;
    title: string;
    detail: string | null;
  } | null>(null);
  // An accepted scan lights the last-scan line for a moment (no overlay: it
  // would hide the counts and the buttons at the line's cadence).
  const [cued, setCued] = useState(false);
  // A close waits for the host's serials.
  const [waitingSerials, setWaitingSerials] = useState(false);
  const [stop, setStopState] = useState<Stop | null>(null);
  const [planReached, setPlanReached] = useState(false);
  // The label the work stopped for: what its panel says under it, and whether a decision runs.
  const [labelNote, setLabelNote] = useState<LabelNote | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const deciding = useRef(false);
  // A label on its way to the printer: the work waits for it, and says so.
  const [sending, setSending] = useState(false);
  const capacity = shift.copy.boxCapacity;
  const plannedQty = shift.copy.plannedQty;

  // What a job reads when it runs, later than the render that queued it.
  const latest: Live = {
    shift,
    operatorId: props.operator.id,
    hostId: props.pairing.hostId,
    deviceId: props.pairing.deviceId,
    local: props.local,
    online: props.online,
    leaving,
    isLeaving: props.isLeaving,
    touch: props.touch,
    track: props.track,
    checkCode: props.checkCode,
    requestBlock: props.requestBlock,
    onHostError: props.onHostError,
    onRecorded: props.onRecorded,
    signal: props.signal ?? playSignalTone,
    closeSteps: props.closeSteps ?? [],
    onClosed: props.onClosed,
    printing: props.printing,
    operatorName: props.operator.name,
    render: props.render,
    t,
  };
  const live = useRef(latest);
  useLayoutEffect(() => {
    live.current = latest;
  });
  // Read by a job in its turn, before React renders the stop it set.
  const stopRef = useRef<Stop | null>(null);
  const setStop = useCallback((next: Stop | null) => {
    stopRef.current = next;
    setStopState(next);
  }, []);
  /**
   * A failed read of this computer's database at the entry (the first thing the
   * queue does, so no other stop stands yet) stops the line.
   */
  const failSystem = useCallback(() => setStop({ kind: "system_error", cause: "read" }), [setStop]);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The computer stays awake while the screen is open (decision 34).
  const { awake } = props;
  useEffect(() => awake.hold(), [awake]);
  const planShown = useRef(false);
  const unsure = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      if (cueTimer.current !== null) clearTimeout(cueTimer.current);
    },
    [],
  );
  const confirmRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLParagraphElement>(null);
  // Counted when the operator answers a message: the element that held the
  // focus is gone after that render, and the focus goes to a safe place instead.
  const [refocused, setRefocused] = useState(0);
  const refocus = useCallback(() => {
    if (alive.current) setRefocused((times) => times + 1);
  }, []);
  useEffect(() => {
    if (refocused === 0) return;
    const close = actionsRef.current?.querySelector<HTMLButtonElement>(
      '[data-action="close-box"]:not(:disabled)',
    );
    (close ?? lastRef.current)?.focus();
  }, [refocused]);
  /** Whether the floor has begun to leave: the render's word, and the floor's own at once. */
  const leavingNow = useCallback(
    () => live.current.leaving || live.current.isLeaving?.() === true,
    [],
  );

  // One queue and one supply for the screen's life: `useState` keeps them, where
  // `useMemo` may be recomputed, and two supplies would both write the block.
  const [queue] = useState(createWorkQueue);
  const [supply] = useState(() => createBlockSupply(blockContextOf(live)));

  const refresh = useCallback(async () => {
    const now = live.current;
    const next = await readWorkTotals(now.local, pairingOf(now), now.shift.copy.id);
    if (alive.current) setTotals(next);
    return next;
  }, []);
  /** The totals again; a failed read leaves what the screen shows, as it is not the work's. */
  const refreshQuietly = useCallback(() => refresh().catch(() => null), [refresh]);

  const show = useCallback((tone: SignalTone, title: string, detail: string | null) => {
    live.current.signal(tone);
    if (!alive.current) return;
    if (tone === "ok") {
      // The tone and a lit line say it: an overlay over every accepted code
      // would cover the counts and swallow the taps of a line at its pace.
      setCued(true);
      if (cueTimer.current !== null) clearTimeout(cueTimer.current);
      cueTimer.current = setTimeout(() => {
        cueTimer.current = null;
        if (alive.current) setCued(false);
      }, CUE_MS);
      return;
    }
    setFlash({ tone, title, detail });
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      if (alive.current) setFlash(null);
    }, SIGNAL_MS);
  }, []);

  /** A top-up of serials as a piece of the floor's work: handed to the gate before it starts. */
  const topUpTracked = useCallback(
    () => live.current.track(Promise.resolve().then(() => supply.topUp())),
    [supply],
  );

  /** After a box closed (also one read back after a lost answer): tell, and keep serials in stock. */
  const afterClosed = useCallback(
    (box: ClosingBox) => {
      live.current.onRecorded();
      try {
        live.current.onClosed?.(box);
      } catch {
        // The label's plan answers for its own failures; the box is closed.
      }
      // The half rule after every close: work of its own, not the line's.
      void topUpTracked().then(
        (topped) => {
          if (topped.kind === "stored") live.current.onRecorded();
        },
        () => undefined,
      );
    },
    [topUpTracked],
  );

  /** The label stop for `job` while it waits; the work goes on when it does not (another stop is left alone). */
  const showLabel = useCallback(
    (job: PrintJob | null) => {
      if (job !== null && isOpenJob(job)) {
        setStop({ kind: "label", job });
        return;
      }
      if (stopRef.current?.kind === "label") setStop(null);
    },
    [setStop],
  );

  /**
   * What the shift's waiting label needs (stage 2a spec §5.7.5), after every
   * close and on entry. A job still `prepared` — written with its box, never
   * sent — goes now: its first send, not a repeat. One that failed, is
   * unknown or waits for its check stops the work. Nothing here sends a label
   * a second time and nothing here recovers interrupted sends: that runs once,
   * on entry, before this (the recovery must never run beside a send). Only
   * from the work queue. A send that was rejected says nothing of where it
   * stands: a stale one reads the job again, any other failure is the caller's
   * to show, whose dismissal comes back here and reads it.
   */
  const settleLabel = useCallback(async (): Promise<void> => {
    const now = live.current;
    let job = await readOpenJob(now.local, pairingOf(now), now.shift.copy.id);
    if (job?.state === "prepared") {
      if (alive.current) setSending(true);
      try {
        // A send writes no record for the host: the status bar has nothing to read again.
        job = await sendLabelJob(printContextOf(live), job);
      } catch (error) {
        if (!(error instanceof StaleJobError)) throw error;
        const again = live.current;
        job = await readOpenJob(again.local, pairingOf(again), again.shift.copy.id);
      } finally {
        if (alive.current) setSending(false);
      }
    }
    showLabel(job);
  }, [showLabel]);

  /** `settleLabel`, whose failure stops the line with its own message instead of being lost. */
  const settleSafely = useCallback(async (): Promise<void> => {
    try {
      await settleLabel();
    } catch {
      setStop({ kind: "system_error", cause: "label" });
    }
  }, [settleLabel, setStop]);

  /**
   * Closes the box — the full one, or the open one the operator confirmed —
   * and when the serials ran out asks the host for a block and tries once
   * more. What is left stops the work with its reason; a write that failed
   * stops it too, so a full box never stays open with nothing to say why.
   * A box that closed (also one read back after a lost answer) has its label
   * settled in the same turn, and a label that already waits keeps the box open.
   */
  const closeBox = useCallback(
    async (full: boolean): Promise<void> => {
      const env: CloseEnv = {
        live,
        supply,
        unsure,
        waiting: (waiting) => {
          if (alive.current) setWaitingSerials(waiting);
        },
      };
      let recovered: ClosingBox | null = null;
      let outcome: CloseOutcome;
      try {
        recovered = await settleUnsure(env);
        outcome = await attemptClose(env, full);
      } catch {
        outcome = { kind: "stop", stop: { kind: "close_failed", full, cause: "write" } };
      }
      if (recovered !== null) afterClosed(recovered);
      if (outcome.kind === "closed") afterClosed(outcome.box);
      if (outcome.kind === "stop") setStop(outcome.stop);
      if (recovered !== null || outcome.kind === "closed" || outcome.kind === "label_waits") {
        await settleSafely();
      }
    },
    [supply, afterClosed, setStop, settleSafely],
  );

  const settle = useCallback(
    async (outcome: ScanOutcome): Promise<void> => {
      const say = live.current.t;
      const boxCapacity = live.current.shift.copy.boxCapacity;
      const text = lastText(outcome, say, boxCapacity);
      setLast(outcome);
      if (outcome.kind === "accepted") {
        show("ok", say("floor.work.signal.ok"), text);
        if (boxIsFull(outcome.itemCount, boxCapacity)) await closeBox(true);
        const next = await refreshQuietly();
        const planned = live.current.shift.copy.plannedQty;
        if (next !== null && planned !== null && !planShown.current && next.accepted >= planned) {
          planShown.current = true;
          if (alive.current) setPlanReached(true);
        }
        return;
      }
      if (outcome.kind === "duplicate") {
        show("duplicate", say("floor.work.signal.duplicate"), text);
        return;
      }
      show(
        "error",
        say(
          outcome.kind === "wrong_gtin"
            ? "floor.work.signal.wrongGtin"
            : "floor.work.signal.invalid",
        ),
        text,
      );
    },
    [closeBox, refreshQuietly, show],
  );

  /** A scan that is not taken: said in words, by flash and by tone, and not written. */
  const refuse = useCallback(
    (leavingNow: boolean) => {
      const say = live.current.t;
      const paused: Last = { kind: "paused", leaving: leavingNow };
      setLast(paused);
      show("error", say("floor.work.signal.paused"), lastText(paused, say, 0));
    },
    [show],
  );

  /**
   * A scan while a label's check waits: its SSCC, compared with the label's.
   * It never reaches the pipeline and is not journalled: another box's label
   * and a code that is no SSCC are said in words and by tone.
   */
  const check = useCallback(
    async (job: PrintJob, raw: string): Promise<void> => {
      const say = live.current.t;
      let result: Awaited<ReturnType<typeof checkLabel>>;
      try {
        result = await checkLabel(printContextOf(live), job, raw);
      } catch (error) {
        if (!(error instanceof StaleJobError || error instanceof UnresolvableJobError)) throw error;
        setLabelNote({ kind: "moved" });
        await settleSafely();
        return;
      }
      if (result.kind === "verified") {
        live.current.onRecorded();
        setLabelNote(null);
        show("ok", say("floor.print.signal.verified"), null);
        showLabel(result.job);
        // A box a stop of the station left full closes now, with its label.
        if (stopRef.current === null) await closeBox(true);
        await refreshQuietly();
        return;
      }
      setLabelNote(result.kind === "mismatch" ? { kind: "mismatch", sscc: result.sscc } : result);
      show(
        "error",
        say(
          result.kind === "mismatch" ? "floor.print.signal.mismatch" : "floor.print.signal.notSscc",
        ),
        null,
      );
    },
    [settleSafely, show, showLabel, closeBox, refreshQuietly],
  );

  /**
   * One scan, in its turn: taken only while nothing stops the work. A box
   * that is already full is closed first (the stop that held it may have been
   * lifted), and if that leaves a stop the scan is not taken. The check of a
   * label takes the scan before the pipeline (plan 2a6's contract).
   */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      const stopped = stopRef.current;
      if (stopped?.kind === "label" && awaitsCheck(stopped.job)) {
        try {
          await check(stopped.job, raw);
        } catch {
          setStop({ kind: "system_error", cause: "label" });
          show("error", live.current.t("floor.work.signal.systemError"), null);
        }
        return;
      }
      if (stopped !== null) {
        refuse(false);
        return;
      }
      await closeBox(true);
      if (stopRef.current !== null) {
        refuse(false);
        return;
      }
      let outcome: ScanOutcome;
      try {
        outcome = await processScan(scanContextOf(live), raw);
      } catch {
        setStop({ kind: "system_error", cause: "write" });
        const say = live.current.t;
        show("error", say("floor.work.signal.systemError"), null);
        return;
      }
      live.current.onRecorded();
      await settle(outcome);
    },
    [check, closeBox, refuse, settle, setStop, show],
  );

  /**
   * A decision on the waiting label, as the line's next piece of work, handed
   * to the gate before it starts: the panel waits while it runs, and shows
   * where the job ended. A printer or a render the decision could not have
   * and a job moved on meanwhile are said under the label; any other failure
   * is the system error of the label, whose dismissal reads the job again
   * (a rejected send says nothing of where it stands). A second press while one
   * runs, and any press once the leave began, does nothing.
   */
  const decide = (work: (job: PrintJob) => Promise<PrintJob>, prints: boolean) => {
    const stopped = stopRef.current;
    if (stopped?.kind !== "label" || deciding.current || leavingNow()) return;
    deciding.current = true;
    setLabelBusy(true);
    setLabelNote(null);
    void live.current
      .track(
        queue.run(async () => {
          try {
            if (prints && alive.current) setSending(true);
            const job = await work(stopped.job);
            live.current.onRecorded();
            showLabel(job);
            if (stopRef.current === null) await closeBox(true);
          } catch (error) {
            if (error instanceof NoPrinterError) setLabelNote({ kind: "no_printer" });
            else if (error instanceof LabelRenderError) setLabelNote({ kind: "render_failed" });
            else if (error instanceof StaleJobError || error instanceof UnresolvableJobError) {
              setLabelNote({ kind: "moved" });
              await settleSafely();
            } else throw error;
          } finally {
            deciding.current = false;
            if (alive.current) {
              setSending(false);
              setLabelBusy(false);
            }
          }
          await refreshQuietly();
        }),
      )
      .catch(() => setStop({ kind: "system_error", cause: "label" }))
      // The button pressed is gone with the panel it was in.
      .finally(refocus);
  };

  const decideAgain = (request: PrintAgain) =>
    decide(async (job) => {
      const now = live.current;
      const settings = await readWorkstationSettings(now.local);
      return printAgain(
        printContextOf(live),
        job,
        request,
        settings,
        now.shift.snapshot.boxTemplate,
        now.render,
      );
    }, true);

  /** The settings the panel says a reprint's printer from (the same read `printAgain` makes). */
  const loadLabelSettings = useCallback(() => readWorkstationSettings(live.current.local), []);

  /** The system error dismissed: the work goes on, after the label that may wait is read again. */
  const dismissSystemError = () => {
    dismiss(() => setStop(null));
    if (leavingNow()) return;
    void live.current
      .track(
        queue.run(async () => {
          await settleSafely();
          await refreshQuietly();
        }),
      )
      .catch(() => undefined);
  };

  useEffect(
    () =>
      source.start((raw) => {
        const now = live.current;
        now.touch();
        if (leavingNow()) {
          refuse(true);
          return;
        }
        // The scan is handed to the gate in the turn before the queue starts it.
        void now.track(queue.run(() => scan(raw))).catch(() => undefined);
      }),
    [source, queue, scan, refuse, leavingNow],
  );

  // On entry: the numbers; the sends a stop of the station cut are unknown now
  // (the one place that recovers them, before anything of this screen sends);
  // the label that waits is settled; and a box the stopped station left full
  // closes first (kept open while a label waits).
  useEffect(() => {
    void live.current
      .track(
        queue.run(async () => {
          await refresh();
          try {
            await recoverInterruptedJobs(printContextOf(live));
          } catch {
            setStop({ kind: "system_error", cause: "label" });
            return;
          }
          await settleSafely();
          await closeBox(true);
          await refreshQuietly();
        }),
      )
      .catch(failSystem);
  }, [queue, refresh, refreshQuietly, settleSafely, closeBox, failSystem, setStop]);

  // On entry and whenever the link is back: serials by the half rule; a close
  // that waited for them goes again.
  const online = props.online;
  useEffect(() => {
    if (!online) return;
    void live.current
      .track(
        Promise.resolve()
          .then(() => supply.topUp())
          .then(async (topped) => {
            if (topped.kind !== "stored") return;
            live.current.onRecorded();
            await live.current.track(
              queue.run(async () => {
                const waiting = stopRef.current;
                if (waiting?.kind !== "no_serials") return;
                setStop(null);
                await closeBox(waiting.full);
                await refreshQuietly();
              }),
            );
          }),
      )
      .catch(() => undefined);
  }, [online, supply, queue, closeBox, refreshQuietly, setStop]);

  /** Runs a close as the line's next piece of work. */
  const closeNow = (full: boolean) => {
    // Nothing the operator presses starts work the leave no longer waits for.
    if (leavingNow()) return;
    setStop(null);
    void live.current
      .track(
        queue.run(async () => {
          await closeBox(full);
          await refreshQuietly();
        }),
      )
      .catch(failSystem)
      // The button pressed is gone, and the box it closed may be too.
      .finally(refocus);
  };

  // The operator who asked to close an incomplete box has the safe answer under their hand.
  const confirming = stop?.kind === "confirm_close";
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector("button")?.focus();
  }, [confirming]);

  /** The operator answers a message: what it held the focus with goes, and the focus goes somewhere safe. */
  const dismiss = (answer: () => void) => {
    answer();
    refocus();
  };

  const openBox = totals?.openBox ?? null;
  const items = openBox?.itemCount ?? 0;
  const canClose = items > 0 && stop === null && !leaving;

  return (
    <Card
      className="standalone-card work-screen"
      title={t("floor.work.title", { number: shift.copy.number })}
      titleAs="h2"
    >
      <div className="standalone-form">
        <p className="shift-card__product">
          {t("floor.work.product", {
            name: shift.snapshot.product.name,
            gtin: shift.snapshot.product.gtin14,
          })}
        </p>
        <dl className="work-screen__facts">
          <div>
            <dt>{t("floor.work.box")}</dt>
            <dd>
              {items === 0
                ? t("floor.work.boxEmpty")
                : t("floor.work.boxItems", {
                    quantity: formatQuantity(items),
                    capacity: formatQuantity(capacity),
                  })}
            </dd>
          </div>
          <div>
            <dt>{t("floor.work.accepted")}</dt>
            <dd>{formatQuantity(totals?.accepted ?? 0)}</dd>
          </div>
          <div>
            <dt>{t("floor.work.closedBoxes")}</dt>
            <dd>{formatQuantity(totals?.closedBoxes ?? 0)}</dd>
          </div>
          <div>
            <dt>{t("floor.work.plan")}</dt>
            <dd>{plannedQty === null ? t("floor.work.noPlan") : formatQuantity(plannedQty)}</dd>
          </div>
          {totals !== null && totals.lastSscc !== null && (
            <div>
              <dt>{t("floor.work.lastSscc")}</dt>
              <dd>{formatSsccHri(totals.lastSscc)}</dd>
            </div>
          )}
        </dl>
        {/*
          A refusal is announced by its flash (an alert); this line keeps every
          verdict in words, and an accepted scan lights it for a moment (the tone
          and the counts carry the rest: no overlay, no announcement per scan).
        */}
        <p
          className={cued ? "work-screen__last work-screen__last--cue" : "work-screen__last"}
          ref={lastRef}
          tabIndex={-1}
        >
          {last === null ? t("floor.work.waiting") : lastText(last, t, capacity)}
        </p>
        {/*
          The stops and notices share one polite region that is on the screen
          before any of them, so each is heard once, when it comes; the alerts
          lose their own role (`presentation`) for that reason.
        */}
        <div className="work-screen__alerts" aria-live="polite">
          {stop?.kind === "system_error" && (
            <Alert
              tone="error"
              role="presentation"
              title={t(`floor.work.systemError.${stop.cause}.title`)}
              action={
                <Button size="floor" variant="secondary" onClick={dismissSystemError}>
                  {t("floor.work.systemError.dismiss")}
                </Button>
              }
            >
              {t(`floor.work.systemError.${stop.cause}.body`)}
            </Alert>
          )}
          {stop?.kind === "no_serials" && (
            <Alert
              tone="warn"
              role="presentation"
              title={t("floor.work.noSerials.title")}
              action={
                <Button
                  size="floor"
                  variant="secondary"
                  aria-disabled={leaving ? true : undefined}
                  style={leaving ? WAITING_STYLE : undefined}
                  onClick={() => closeNow(stop.full)}
                >
                  {t("floor.work.retry")}
                </Button>
              }
            >
              {t(
                stop.reason === "offline" && linkHeld
                  ? "floor.work.noSerials.held"
                  : `floor.work.noSerials.${stop.reason}`,
              )}
            </Alert>
          )}
          {stop?.kind === "close_failed" && (
            <Alert
              tone="error"
              role="presentation"
              title={t("floor.work.closeFailed.title")}
              action={
                <Button
                  size="floor"
                  variant="secondary"
                  aria-disabled={leaving ? true : undefined}
                  style={leaving ? WAITING_STYLE : undefined}
                  onClick={() => closeNow(stop.full)}
                >
                  {t("floor.work.retry")}
                </Button>
              }
            >
              {t(`floor.work.closeFailed.${stop.cause}`)}
            </Alert>
          )}
          {planReached && (
            <Alert
              tone="ok"
              role="presentation"
              title={t("floor.work.planReached", {
                quantity: formatQuantity(totals?.accepted ?? 0),
                planned: formatQuantity(plannedQty ?? 0),
              })}
              action={
                <Button
                  size="floor"
                  variant="secondary"
                  onClick={() => dismiss(() => setPlanReached(false))}
                >
                  {t("floor.work.continue")}
                </Button>
              }
            />
          )}
          {waitingSerials && (
            <p className="work-screen__waiting">{t("floor.work.waitingSerials")}</p>
          )}
          {sending && <p className="work-screen__waiting">{t("floor.print.sending")}</p>}
          {stop?.kind === "label" && (
            <LabelPanel
              // A new job, state or attempt starts the panel afresh.
              key={`${stop.job.id}:${stop.job.state}:${stop.job.attempts}`}
              job={stop.job}
              busy={labelBusy || leaving}
              note={labelNote}
              loadSettings={loadLabelSettings}
              onPrintAgain={decideAgain}
              onPrinted={() => decide((job) => confirmPrinted(printContextOf(live), job), false)}
              onSkip={() => decide((job) => skipLabel(printContextOf(live), job), false)}
              {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
            />
          )}
        </div>
        {confirming && (
          <div className="work-screen__confirm" ref={confirmRef}>
            <p>
              {t("floor.work.confirmClose", {
                quantity: formatQuantity(items),
                capacity: formatQuantity(capacity),
              })}
            </p>
            <div className="standalone-form__actions">
              <Button size="floor" variant="secondary" onClick={() => dismiss(() => setStop(null))}>
                {t("floor.work.keepFilling")}
              </Button>
              <Button
                size="floor"
                aria-disabled={leaving ? true : undefined}
                style={leaving ? WAITING_STYLE : undefined}
                onClick={() => closeNow(false)}
              >
                {t("floor.work.closeBox")}
              </Button>
            </div>
          </div>
        )}
        <div className="standalone-form__actions" ref={actionsRef}>
          {!confirming && (
            <Button
              size="floor"
              variant="secondary"
              data-action="close-box"
              disabled={!canClose}
              onClick={() => setStop({ kind: "confirm_close" })}
            >
              {t("floor.work.closeBox")}
            </Button>
          )}
          {/* On the keyboard while the leave waits: `aria-disabled`, and a press that does nothing. */}
          <Button
            size="floor"
            variant="secondary"
            aria-disabled={leaving ? true : undefined}
            style={leaving ? WAITING_STYLE : undefined}
            onClick={leaving ? undefined : onLeave}
          >
            {t("floor.work.leave")}
          </Button>
        </div>
        {/* Always on the screen, so that the text put into it is announced. */}
        <p className="work-screen__leaving" aria-live="polite">
          {leaving ? t("floor.work.leaving") : ""}
        </p>
      </div>
      {flash !== null && (
        // Never in the way of a tap: the words and the tone already say it.
        <div className="work-screen__flash" style={{ pointerEvents: "none" }}>
          <SignalOverlay
            tone={flash.tone}
            title={flash.title}
            {...(flash.detail === null ? {} : { detail: flash.detail })}
          />
        </div>
      )}
    </Card>
  );
}
