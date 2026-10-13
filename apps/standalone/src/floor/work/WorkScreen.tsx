import { formatSsccHri, type ShiftCloseReasonCode } from "@markiro/domain";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, SignalOverlay, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { SystemAwake } from "../../hardware/awake.js";
import type { CodeCheck, SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  ShiftClosedPanel,
  ShiftClosePanel,
  sameSummary,
  type CloseNote,
  type ClosedNumbers,
} from "../close/ShiftClosePanel.js";
import { closeShift, readCloseSummary, type CloseSummary } from "../close/shift-close.js";
import {
  BoxUnavailableError,
  clearOpenBox,
  disassembleBox,
  LabelWaitingError,
  readClosedBoxes,
  reprintBox,
  TemplateChangedError,
  undoLastCode,
  type ClosedBox,
  type OpenBoxResult,
} from "../exceptions/box-exceptions.js";
import {
  ExceptionFlow,
  type BoxScanVerdict,
  type ExceptionOutcome,
} from "../exceptions/ExceptionFlow.js";
import {
  disassemblePallet,
  PalletTemplateChangedError,
  PalletUnavailableError,
  readClosedPallets,
  reprintPallet,
  type ClosedPallet,
} from "../exceptions/pallet-exceptions.js";
import { PalletStrip } from "../pallets/PalletStrip.js";
import {
  closeOpenPallet,
  closePalletIfFull,
  openPalletGuard,
  PALLET_EXTENSION,
  palletStep,
  readOpenPallet,
  shiftPallets,
  type OpenPallet,
  type PalletCloseResult,
  type PalletContext,
  type ShiftPallets,
} from "../pallets/pallets.js";
import { LabelPanel, type LabelNote } from "../print/LabelPanel.js";
import {
  boxLabelStep,
  isOpenJob,
  readOpenJob,
  readPrintJob,
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
import { shiftLabelRender } from "../print/shift-render.js";
import type { ScanSource } from "../scan-source.js";
import { readWorkstationSettings } from "../setup/workstation-settings.js";
import { FloorFooter } from "../shifts/FloorScreen.js";
import type { WorkShift } from "../shifts/shift-copies.js";
import { formatQuantity } from "../shifts/shift-text.js";
import { createBlockSupply, type BlockContext, type SupplyResult } from "./block-supply.js";
import {
  BOX_EXTENSION,
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
import { ValidationPanel, type ValidationOutcome } from "./ValidationPanel.js";
import {
  readOpenBox,
  readValidationCounts,
  readWorkTotals,
  type ValidationCounts,
  type WorkTotals,
} from "./work-reads.js";
import {
  BoxFill,
  FooterAction,
  LastScan,
  ShiftBand,
  WorkFacts,
  type LastTone,
} from "./WorkInstruments.js";
import "./work-screen.css";

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
 *   leave started by a timer or an answer (the idle lock) may not have had
 *   yet: `isLeaving` says it at once, and the screen asks both.
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
 * - The shift's close (plan 2a8) is the queue's work too, handed to `track`
 *   before it starts, and it needs no host. After it the screen is at its end
 *   (the `closed` stop): no scan is taken, nothing is written, and the way
 *   out — «К списку смен», «Выйти из смены» — is never held. A leave that
 *   began first starts no close.
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
  /** The label panel's clock (milliseconds, never going back); tests drive it. */
  labelClock?: () => number;
  /**
   * The office closed the shift after this station entered it (plan 2a8):
   * no new code is taken, while the box, its label, the exceptions and the
   * shift's close are finished as usual.
   */
  officeClosed?: boolean;
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
   * Plan ПЛ-Ц: the shift works with pallets, but this station's copy has no
   * boxes per pallet or no pallet layout. The work never goes on with boxes
   * alone (their pallets would be lost): nothing is taken until the operator
   * leaves and enters the shift again.
   */
  | { kind: "pallets_missing" }
  /** The early close of the open pallet, to confirm (plan ПЛ-Ц). */
  | { kind: "confirm_pallet" }
  /**
   * The early close found no pallet serial (the serials' reason), and waits for the operator's retry.
   * `fromClose`: it was «Закрыть паллету и смену» that stopped here, so the shift is NOT closed.
   */
  | {
      kind: "pallet_no_serials";
      reason: "offline" | "exhausted" | "failed";
      fromClose: boolean;
    }
  /**
   * The early close did not take: its serial was lost, or the pallet changed meanwhile (three tries).
   * `fromClose`: as above, the shift stays open.
   */
  | { kind: "pallet_failed"; fromClose: boolean }
  /**
   * `serial`: the block's serial does not fit (past the prefix's range, or an
   * SSCC a box already holds) and is spent; `write`: the close did not reach
   * the database (a failed write, or three tries that found the box changed).
   */
  | { kind: "close_failed"; full: boolean; cause: "serial" | "write" }
  /** The label of a closed box waits: its check, or its recovery (plan 2a7, spec §5.7.5). */
  | { kind: "label"; job: PrintJob }
  /**
   * The exceptions of the box (plan 2a8, spec §5.7.6), opened while nothing
   * else stops the work and no label waits; `boxes`: the shift's closed
   * boxes once they are read; `pallets`: the closed pallets of a shift with
   * pallets (plan ПЛ-Ц), `null` while they are read (and without pallets).
   */
  | {
      kind: "exceptions";
      boxes: readonly ClosedBox[] | null;
      pallets: readonly ClosedPallet[] | null;
    }
  /**
   * The summary of the shift's close (plan 2a8, spec §5.7.7), `null` while it
   * is read; `waitingSscc`: the label that keeps the shift open, when there is one;
   * `attempt`: how many times the summary has been shown again, so that two
   * re-shows in a row are two views for the panel's guard.
   */
  | {
      kind: "close";
      summary: CloseSummary | null;
      note: CloseNote | null;
      waitingSscc: string | null;
      attempt: number;
    }
  /** The shift is closed on this station: the end of its work screen, no scan is taken again. */
  | { kind: "closed"; record: ClosedNumbers };

/** What an exception's failure says on the screen; anything unforeseen is this computer's failed write. */
function outcomeOf(error: unknown): ExceptionOutcome {
  // By class, never by text: the message of a `LabelWaitingError` is for the log, and
  // `PalletTemplateChangedError` is a `PalletUnavailableError`, so it is asked first.
  if (error instanceof TemplateChangedError || error instanceof PalletTemplateChangedError) {
    return { kind: "template_changed" };
  }
  if (error instanceof BoxUnavailableError || error instanceof PalletUnavailableError) {
    return { kind: "unavailable" };
  }
  if (error instanceof LabelWaitingError) return { kind: "label_waiting" };
  // Another reprint of the box landed between this one's read and its write: nothing was written.
  if (error instanceof StaleJobError) return { kind: "stale" };
  return { kind: "failed" };
}

/** An exception on the open box, as the screen says it. */
function openBoxOutcome(result: OpenBoxResult, action: "undo" | "clear"): ExceptionOutcome {
  return result.kind === "done" ? { kind: "done", action } : result;
}

/** The last scan, said in words under the box. */
type Last =
  | ScanOutcome
  | { kind: "paused"; leaving: boolean }
  | { kind: "shift_closed" }
  | { kind: "office_closed" };

/** How long the coloured flash of a refusal covers the screen (an accepted scan has none). */
export const SIGNAL_MS = 700;

/** How long the last-scan line is lit after an accepted scan. */
export const CUE_MS = 350;

/** How many times a close that found the box or the block changed is tried in all. */
const CLOSE_TRIES = 3;

/**
 * How many pallet serials a pallet's close may lose in a row, one per try: the full pallet's
 * close then waits for the next close, the early close stops with «Повторить» (plan ХП).
 */
const PALLET_SERIAL_TRIES = 3;

/** The stop of a shift that works with pallets and has none to work with. */
const PALLETS_MISSING: Stop = { kind: "pallets_missing" };

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

/** How many outcomes the validation panel lists (plan РЕЖ). */
const VALIDATION_OUTCOMES = 5;

/** The last scan in words. */
function lastText(last: Last, t: TFunction, capacity: number): string {
  switch (last.kind) {
    case "accepted":
      // A validation shift's code is in no box (plan РЕЖ): the shift's count is said instead.
      if (last.boxId === null) {
        return t("floor.validation.accepted", { quantity: formatQuantity(last.acceptedCount) });
      }
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
    case "shift_closed":
      return t("floor.work.last.closed");
    case "office_closed":
      return t("floor.work.last.officeClosed");
  }
}

/** The button the exceptions were opened by (its `data-action`), where the focus returns. */
type ExceptionsOpener = "exceptions" | "box-undo" | "box-clear";

/** The tone of the last scan's verdict: accepted, refused, not taken, or none yet. */
function lastTone(last: Last | null): LastTone {
  if (last === null) return "neutral";
  switch (last.kind) {
    case "accepted":
      return "ok";
    case "duplicate":
    case "wrong_gtin":
    case "invalid":
      return "error";
    case "paused":
    case "shift_closed":
    case "office_closed":
      return "warn";
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
  officeClosed: boolean;
  isLeaving: (() => boolean) | undefined;
  touch: () => void;
  track: <T>(work: Promise<T>) => Promise<T>;
  checkCode: (codeHash: string) => Promise<CodeCheck>;
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  onHostError: (error: unknown) => void;
  onRecorded: () => void;
  signal: (tone: SignalTone) => void;
  closeSteps: readonly CloseStep[];
  /** The shift's boxes per pallet and pallet layout; `null` for a shift without pallets (plan ПЛ-Ц). */
  pallets: ShiftPallets | null;
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

/** The context of a pallet's close: a box's, the operator's name for the label, the render. */
function palletContextOf(live: LiveRef): PalletContext {
  const now = live.current;
  return {
    ...boxContextOf(live),
    operatorName: now.operatorName,
    ...(now.render === undefined ? {} : { render: now.render }),
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
 * The context of one of the screen's block supplies — the box's (extension 0)
 * and, for a shift with pallets, the pallet's (extension 1, plan ПЛ-Ц). It
 * reads everything through `live`, so a supply is made once and never again,
 * whatever the floor gives the screen later (two supplies of one extension at
 * once would both write the block).
 */
function blockContextOf(live: LiveRef, extension: number): BlockContext {
  return {
    extension,
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

/** A close again on `stale` (nothing was written: the box, the pallet or the block changed meanwhile). */
async function closeSettled<Result extends { kind: string } | null>(
  close: () => Promise<Result>,
): Promise<Result> {
  let result = await close();
  for (let attempt = 1; attempt < CLOSE_TRIES && result?.kind === "stale"; attempt += 1) {
    result = await close();
  }
  return result;
}

/**
 * A pallet's close again while it lost a serial that cannot label a pallet (`invalid_serial`:
 * past the prefix's range, or its SSCC held by another pallet): each such answer spent that
 * serial alone, so the next call takes the next one, `PALLET_SERIAL_TRIES` calls in all — the
 * full pallet's close and the early close alike (plan ХП).
 */
async function closeLosingBadSerials<Result extends { kind: string } | null>(
  close: () => Promise<Result>,
): Promise<Result> {
  let result = await close();
  for (
    let tries = 1;
    tries < PALLET_SERIAL_TRIES && result?.kind === "invalid_serial";
    tries += 1
  ) {
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
      // A box of a shift with pallets joins the open pallet in its own close (plan ПЛ-Ц).
      const pallets = env.live.current.pallets;
      const steps = [
        label,
        ...env.live.current.closeSteps,
        ...(pallets === null ? [] : [palletStep(palletContextOf(env.live), pallets)]),
      ];
      return await closeOpenBox(boxContextOf(env.live), steps);
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
  const { shift, leaving, onLeave, source, linkHeld = false, officeClosed = false } = props;
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
  // The one point where the screen chooses by the shift's mode (plan РЕЖ): a validation shift
  // takes its codes without a box, so it has no box, pallet, label, exceptions or SSCC serials;
  // its panel stands where the box does. The mode never changes once the shift is open.
  const validation = shift.copy.mode === "validation";
  // The shift's pallets (plan ПЛ-Ц): what its copy and snapshot give. A shift that
  // works with pallets and gives none is a stop from the first render, never boxes alone.
  const pallets = validation ? null : shiftPallets(shift);
  const palletsMissing = !validation && shift.copy.palletsEnabled && pallets === null;
  const [stop, setStopState] = useState<Stop | null>(palletsMissing ? PALLETS_MISSING : null);
  const [planReached, setPlanReached] = useState(false);
  // The label the work stopped for: what its panel says under it, and whether a decision runs.
  const [labelNote, setLabelNote] = useState<LabelNote | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const deciding = useRef(false);
  // A label on its way to the printer: the work waits for it, and says so.
  const [sending, setSending] = useState(false);
  // The shift's close is being written; a second press meanwhile starts nothing.
  const [closing, setClosing] = useState(false);
  const closeRunning = useRef(false);
  // The shift's open pallet and what it holds.
  const [pallet, setPallet] = useState<OpenPallet | null>(null);
  // The open pallet is full but did not close: no pallet serial is here ("no_serials"),
  // or the one tried could not label a pallet ("invalid"). It closes with the next serials.
  // Shown only while the pallet that `refresh` reads is still full (see `palletWaitsNow`),
  // so it cannot outlive the pallet it speaks of.
  const [palletWaits, setPalletWaits] = useState<"no_serials" | "invalid" | null>(null);
  // A validation shift's refused scans by kind, and the outcomes of this entry, newest first.
  const [counts, setCounts] = useState<ValidationCounts | null>(null);
  const [outcomes, setOutcomes] = useState<readonly ValidationOutcome[]>([]);
  const outcomeId = useRef(0);
  const capacity = shift.copy.boxCapacity;
  const plannedQty = shift.copy.plannedQty;

  // How the shift's labels are rendered: a test's own, else from the shift's snapshot, with
  // the organization logo it froze or the Markiro one (plan А4, #703).
  const render = props.render ?? shiftLabelRender(shift);
  // What a job reads when it runs, later than the render that queued it.
  const latest: Live = {
    shift,
    operatorId: props.operator.id,
    hostId: props.pairing.hostId,
    deviceId: props.pairing.deviceId,
    local: props.local,
    online: props.online,
    leaving,
    officeClosed,
    isLeaving: props.isLeaving,
    touch: props.touch,
    track: props.track,
    checkCode: props.checkCode,
    requestBlock: props.requestBlock,
    onHostError: props.onHostError,
    onRecorded: props.onRecorded,
    signal: props.signal ?? playSignalTone,
    closeSteps: props.closeSteps ?? [],
    pallets,
    onClosed: props.onClosed,
    printing: props.printing,
    operatorName: props.operator.name,
    render,
    t,
  };
  const live = useRef(latest);
  useLayoutEffect(() => {
    live.current = latest;
  });
  // Read by a job in its turn, before React renders the stop it set.
  const stopRef = useRef<Stop | null>(stop);
  // «Закрыть паллету и смену» whose pallet's label waits for the operator: the shift's
  // close goes, with the reason chosen, once that label — the job `jobId` — is decided
  // (plan ПЛ-Ц). `shown` is the summary the operator pressed on: the close goes on its
  // numbers and on no others. The intention ends with that label's stop: a stop of
  // anything else, another label included, drops it (`setStop`), and so does a check
  // or a decision that found the label moved; the operator presses «Закрыть смену» again.
  const pendingClose = useRef<{
    reason: ShiftCloseReasonCode | null;
    shown: CloseSummary;
    jobId: string;
  } | null>(null);
  // The same, said to the operator: the label's panel tells the shift closes after it.
  const [closeAfterLabel, setCloseAfterLabel] = useState(false);
  // Which button opened the exceptions: the footer's, or one of the open box's own.
  const [exceptionsFrom, setExceptionsFrom] = useState<ExceptionsOpener>("exceptions");
  const setPendingClose = useCallback((next: typeof pendingClose.current) => {
    pendingClose.current = next;
    setCloseAfterLabel(next !== null);
  }, []);
  const setStop = useCallback(
    (next: Stop | null) => {
      stopRef.current = next;
      setStopState(next);
      // Only the intention's own label may stand while it waits; no stop at all is the
      // decision of that label, which `afterLabel` reads next.
      const pending = pendingClose.current;
      if (pending === null || next === null) return;
      if (next.kind !== "label" || next.job.id !== pending.jobId) setPendingClose(null);
    },
    [setPendingClose],
  );
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
  const actionsRef = useRef<HTMLElement>(null);
  const lastRef = useRef<HTMLParagraphElement>(null);
  // Counted when the operator answers a message: the element that held the
  // focus is gone after that render, and the focus goes to a safe place instead.
  const [refocused, setRefocused] = useState(0);
  // The refocus follows an answer about the pallet (plan ПЛ-Ц).
  const palletRefocus = useRef(false);
  const refocus = useCallback(() => {
    if (alive.current) setRefocused((times) => times + 1);
  }, []);
  useEffect(() => {
    if (refocused === 0) return;
    // After the pallet's questions the focus returns to the pallet's button when it is still there.
    const asked = palletRefocus.current;
    palletRefocus.current = false;
    const pick = (action: string) =>
      actionsRef.current?.querySelector<HTMLButtonElement>(
        `[data-action="${action}"]:not(:disabled)`,
      );
    const close = (asked ? pick("close-pallet") : null) ?? pick("close-box");
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
  const [supply] = useState(() => createBlockSupply(blockContextOf(live, BOX_EXTENSION)));
  // The pallet serials' own supply (extension 1); a shift without pallets never asks it.
  const [palletSupply] = useState(() => createBlockSupply(blockContextOf(live, PALLET_EXTENSION)));

  const refresh = useCallback(async () => {
    const now = live.current;
    const next = await readWorkTotals(now.local, pairingOf(now), now.shift.copy.id);
    const open =
      now.pallets === null
        ? null
        : await readOpenPallet(now.local, pairingOf(now), now.shift.copy.id);
    const refusals =
      now.shift.copy.mode === "validation"
        ? await readValidationCounts(now.local, pairingOf(now), now.shift.copy.id)
        : null;
    if (alive.current) {
      setTotals(next);
      setPallet(open);
      setCounts(refusals);
    }
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

  /**
   * The turn a pallet block brought by a box's top-up queues (plan ХП); set once
   * `settlePalletSafely` exists, below. Until then it does nothing.
   */
  const palletArrived = useRef<() => Promise<void>>(() => Promise.resolve());

  /** After a box closed (also one read back after a lost answer): tell, and keep serials in stock. */
  const afterClosed = useCallback(
    (box: ClosingBox) => {
      live.current.onRecorded();
      try {
        live.current.onClosed?.(box);
      } catch {
        // The label's plan answers for its own failures; the box is closed.
      }
      // The half rule after every close: work of its own, not the line's — for the
      // pallet serials too, in a shift with pallets. A pallet block that comes queues the
      // full pallet's close as a turn of its own (plan ХП): the box's turn never waits for
      // the host. The gate holds the whole chain, the queued turn included.
      for (const blocks of live.current.pallets === null ? [supply] : [supply, palletSupply]) {
        const pallet = blocks === palletSupply;
        void live.current
          .track(
            Promise.resolve()
              .then(() => blocks.topUp())
              .then(async (topped) => {
                if (topped.kind !== "stored") return;
                live.current.onRecorded();
                if (pallet) await palletArrived.current();
              }),
          )
          .catch(() => undefined);
      }
    },
    [supply, palletSupply],
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
   * What the shift's waiting labels need (stage 2a spec §5.7.5), after every
   * close and on entry. A job still `prepared` — written with its box or
   * pallet, never sent — goes now: its first send, not a repeat; the box's
   * before the pallet's that its close filled (plan ПЛ-Ц), the next one as
   * soon as the one before it is done with. One that failed, is unknown or
   * waits for its check stops the work, and the label behind it waits. Nothing
   * here sends a label a second time and nothing here recovers interrupted
   * sends: that runs once, on entry, before this (the recovery must never run
   * beside a send). Only from the work queue. A send that was rejected says
   * nothing of where it stands: a stale one reads the job again (a job that is
   * still the same one is shown, never sent in a loop), any other failure is
   * the caller's to show, whose dismissal comes back here and reads it.
   * A decision on a label that leaves another one prepared calls this again.
   *
   * Known limit, left to the owner / plan 2b: a job this build cannot read
   * (`UnreadableJobError`) makes this read throw every time: that shift's line
   * stays on the label system message until the operator leaves the shift.
   * There is no bypass here on purpose; the proposal is in
   * `UnreadableJobError`'s JSDoc.
   */
  const settleLabel = useCallback(async (): Promise<void> => {
    const now = live.current;
    let job = await readOpenJob(now.local, pairingOf(now), now.shift.copy.id);
    while (job?.state === "prepared") {
      const first: PrintJob = job;
      if (alive.current) setSending(true);
      try {
        // A send writes no record for the host: the status bar has nothing to read again.
        job = await sendLabelJob(printContextOf(live), first);
      } catch (error) {
        if (!(error instanceof StaleJobError)) throw error;
        const again = live.current;
        job = await readOpenJob(again.local, pairingOf(again), again.shift.copy.id);
        if (job?.id === first.id) break;
        continue;
      } finally {
        if (alive.current) setSending(false);
      }
      // The oldest that still waits is read again: one that stops the work is
      // that one, and the next waits behind it; one done with lets the next go.
      const next = live.current;
      job = await readOpenJob(next.local, pairingOf(next), next.shift.copy.id);
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
   * The full open pallet's close (`closePalletIfFull`, plan ПЛ-Ц), a serial
   * that cannot label a pallet lost per try and a stale write tried again:
   * each call that answers `invalid_serial` has spent one bad serial, so the
   * next takes the next, a few times, and the line never stops on it. Only
   * from the work queue.
   */
  const closeFullPallet = useCallback(async (): Promise<PalletCloseResult | null> => {
    const pallets = live.current.pallets;
    if (pallets === null) return null;
    return closeLosingBadSerials(() =>
      closeSettled(() => closePalletIfFull(palletContextOf(live), pallets)),
    );
  }, []);

  /**
   * A full pallet that waited for pallet serials closes once they are here
   * (plan ПЛ-Ц): after a box's close, on entry, and when serials arrive, while
   * no label waits. Without them the screen says the pallet waits and the next
   * boxes join it — the line never stops for it, and this turn never waits for the host
   * (plan ХП): the block a box's top-up or the link's return brings queues it again. The
   * pallet's label goes at
   * once, after the box's. Only from the work queue.
   */
  const settlePallet = useCallback(async (): Promise<void> => {
    if (live.current.pallets === null) return;
    const result = await closeFullPallet();
    if (alive.current) {
      setPalletWaits(
        result?.kind === "no_serials"
          ? "no_serials"
          : result?.kind === "invalid_serial"
            ? "invalid"
            : null,
      );
    }
    if (result?.kind === "closed") {
      live.current.onRecorded();
      await settleLabel();
    }
  }, [closeFullPallet, settleLabel]);

  /** `settlePallet`, whose failure stops the line with the failed write instead of being lost. */
  const settlePalletSafely = useCallback(async (): Promise<void> => {
    try {
      await settlePallet();
    } catch {
      setStop({ kind: "system_error", cause: "write" });
    }
  }, [settlePallet, setStop]);

  // The turn a pallet block from a box's top-up queues (plan ХП): the full pallet that waited
  // for serials closes while no stop stands, as the link-back's turn does.
  useLayoutEffect(() => {
    palletArrived.current = () =>
      live.current.track(
        queue.run(async () => {
          if (stopRef.current === null) await settlePalletSafely();
          await refreshQuietly();
        }),
      );
  }, [queue, settlePalletSafely, refreshQuietly]);

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
        // The box that filled its pallet closed it in its own write; one that found no
        // pallet serial left it open, and it closes now if serials are here.
        if (stopRef.current === null) await settlePalletSafely();
      }
    },
    [supply, afterClosed, setStop, settleSafely, settlePalletSafely],
  );

  /** The label that keeps the shift from closing, named by its SSCC; `null` when none is read. */
  const waitingLabel = useCallback(async (summary: CloseSummary): Promise<string | null> => {
    if (summary.blocker?.kind !== "label") return null;
    try {
      const now = live.current;
      const job = await readOpenJob(now.local, pairingOf(now), now.shift.copy.id);
      return job === null ? null : formatSsccHri(job.sscc);
    } catch {
      return null;
    }
  }, []);

  /** The shift is closed on this station: the end of this screen's work. */
  const showClosed = useCallback(
    (summary: CloseSummary) =>
      setStop({
        kind: "closed",
        record: { actualQty: summary.actualQty, closedBoxCount: summary.closedBoxes },
      }),
    [setStop],
  );

  /**
   * A shift found closed on this station, wherever it was found: the end of
   * this screen's work. The floor is told of a record, for the close may not
   * have been told yet (a write whose answer was lost): it is harmless when
   * it has.
   */
  const foundClosed = useCallback(
    (summary: CloseSummary) => {
      live.current.onRecorded();
      showClosed(summary);
    },
    [showClosed],
  );

  /**
   * The summary on the screen, unless the operator has gone back from it
   * meanwhile; a shift found closed is the closed stop instead. Every showing
   * is a new `attempt`, so the panel's guard over «Подтвердить закрытие»
   * starts again each time, however alike two showings are.
   */
  const showSummary = useCallback(
    async (summary: CloseSummary, note: CloseNote | null): Promise<void> => {
      if (summary.blocker?.kind === "closed") {
        foundClosed(summary);
        return;
      }
      const waitingSscc = await waitingLabel(summary);
      const now = stopRef.current;
      if (now?.kind === "close") {
        setStop({ kind: "close", summary, note, waitingSscc, attempt: now.attempt + 1 });
      }
    },
    [foundClosed, waitingLabel, setStop],
  );

  /** The shift's close summary as this station's records have it now. */
  const readSummaryNow = useCallback((): Promise<CloseSummary> => {
    const now = live.current;
    return readCloseSummary(now.local, pairingOf(now), now.shift.copy.id);
  }, []);

  /**
   * The close's write failed or its answer was lost (it may have been
   * committed): the summary is read back. Closed after all, or still open and
   * said so; a re-read that failed too knows nothing, and the note says so
   * instead of claiming the shift open.
   */
  const closeFailed = useCallback(
    async (shown: CloseSummary): Promise<void> => {
      const again = await readSummaryNow().catch(() => null);
      if (again !== null) {
        await showSummary(again, "failed");
      } else if (stopRef.current?.kind === "close") {
        setStop({
          kind: "close",
          summary: shown,
          note: "unknown",
          waitingSscc: null,
          attempt: stopRef.current.attempt + 1,
        });
      }
    },
    [readSummaryNow, showSummary, setStop],
  );

  /**
   * The shift's close itself (stage 2a spec §5.7.7), the one path of
   * «Подтвердить закрытие» and of «Закрыть паллету и смену»: a local write that
   * needs no host, with the open pallet's check of plan ПЛ-Ц in its
   * transaction — on every path, for the pallet may have changed since any
   * reading of the summary. A shift that changed since it shows the summary
   * again with why; a write that failed is read back (`closeFailed`). Only from
   * the work queue, handed to the gate.
   */
  const finishClose = useCallback(
    async (reason: ShiftCloseReasonCode | null, shown: CloseSummary): Promise<void> => {
      try {
        const now = live.current;
        const guards = [openPalletGuard(pairingOf(now), now.shift.copy.id)];
        const result = await closeShift(boxContextOf(live), reason, guards);
        if (result.kind === "closed") {
          live.current.onRecorded();
          setStop({ kind: "closed", record: result.record });
          return;
        }
        await showSummary(
          await readSummaryNow(),
          result.kind === "reason_required" ? "reason" : "stale",
        );
      } catch {
        // The write may have been committed, and only its answer lost.
        await closeFailed(shown);
      }
    },
    [showSummary, readSummaryNow, closeFailed, setStop],
  );

  /**
   * After a label is decided and nothing stops the work: the shift's close that
   * waited for its pallet's label goes now (plan ПЛ-Ц), unless the leave began
   * first — on the numbers the operator saw, read again; other numbers are shown
   * with why instead. Otherwise a box a stop of the station left full closes,
   * then a full pallet that waited. Only from the work queue.
   */
  const afterLabel = useCallback(async (): Promise<void> => {
    if (stopRef.current !== null) return;
    const pending = pendingClose.current;
    if (pending !== null) {
      setPendingClose(null);
      // A leave that began first starts no close.
      if (leavingNow()) return;
      const { reason, shown } = pending;
      setStop({ kind: "close", summary: null, note: null, waitingSscc: null, attempt: 0 });
      if (alive.current) setClosing(true);
      try {
        // Only the open pallet the operator was asked about may have changed: it is closed now.
        const fresh = await readSummaryNow();
        if (!sameSummary({ ...shown, blocker: null }, fresh)) {
          await showSummary(fresh, "stale");
          return;
        }
        await finishClose(reason, shown);
      } catch {
        await closeFailed(shown);
      } finally {
        if (alive.current) setClosing(false);
      }
      return;
    }
    await closeBox(true);
    if (stopRef.current === null) await settlePalletSafely();
  }, [
    finishClose,
    readSummaryNow,
    showSummary,
    closeFailed,
    closeBox,
    settlePalletSafely,
    leavingNow,
    setStop,
    setPendingClose,
  ]);

  const settle = useCallback(
    async (outcome: ScanOutcome): Promise<void> => {
      const say = live.current.t;
      const boxCapacity = live.current.shift.copy.boxCapacity;
      const text = lastText(outcome, say, boxCapacity);
      setLast(outcome);
      if (live.current.shift.copy.mode === "validation" && alive.current) {
        outcomeId.current += 1;
        const said: ValidationOutcome = {
          id: outcomeId.current,
          time: scanTime(new Date().toISOString()),
          text,
          tone: lastTone(outcome),
        };
        setOutcomes((before) => [said, ...before].slice(0, VALIDATION_OUTCOMES));
      }
      if (outcome.kind === "accepted") {
        show("ok", say("floor.work.signal.ok"), text);
        if (outcome.boxId !== null && boxIsFull(outcome.itemCount, boxCapacity)) {
          await closeBox(true);
        }
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
      } else {
        show(
          "error",
          say(
            outcome.kind === "wrong_gtin"
              ? "floor.work.signal.wrongGtin"
              : "floor.work.signal.invalid",
          ),
          text,
        );
      }
      // A validation shift's panel counts the refused scans too (plan РЕЖ).
      if (live.current.shift.copy.mode === "validation") await refreshQuietly();
    },
    [closeBox, refreshQuietly, show],
  );

  /** A scan that is not taken: said in words, by flash and by tone, and not written. */
  const refuse = useCallback(
    (leavingNow: boolean, shiftClosed = false, officeClosedNow = false) => {
      const say = live.current.t;
      const refused: Last = officeClosedNow
        ? { kind: "office_closed" }
        : shiftClosed
          ? { kind: "shift_closed" }
          : { kind: "paused", leaving: leavingNow };
      setLast(refused);
      show("error", say("floor.work.signal.paused"), lastText(refused, say, 0));
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
        // The label was not decided here: an intention to close after it ends.
        setPendingClose(null);
        setLabelNote({ kind: "moved" });
        await settleSafely();
        return;
      }
      if (result.kind === "verified") {
        live.current.onRecorded();
        setLabelNote(null);
        show("ok", say("floor.print.signal.verified"), null);
        showLabel(result.job);
        // The box's label decided, the pallet's that its close filled goes next.
        if (stopRef.current === null) await settleSafely();
        // A box a stop of the station left full closes now, with its label; so does a
        // full pallet that waited, or a shift's close that waited for this label.
        await afterLabel();
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
    [settleSafely, show, showLabel, afterLabel, refreshQuietly, setPendingClose],
  );

  // The box choice of the exceptions, when it listens: a scan of a label picks the box.
  const targetScan = useRef<((raw: string) => BoxScanVerdict | null) | null>(null);
  const registerScan = useCallback((listener: ((raw: string) => BoxScanVerdict | null) | null) => {
    targetScan.current = listener;
  }, []);
  const textEntry = useCallback(
    (active: boolean) => source.setManualTextEntryActive(active),
    [source],
  );

  /**
   * One scan, in its turn: taken only while nothing stops the work. A box
   * that is already full is closed first (the stop that held it may have been
   * lifted), and if that leaves a stop the scan is not taken. The check of a
   * label takes the scan before the pipeline (plan 2a6's contract); the box
   * choice of the exceptions takes it before that, and nothing is journalled.
   */
  const scan = useCallback(
    async (raw: string): Promise<void> => {
      const stopped = stopRef.current;
      const choose = targetScan.current;
      if (stopped?.kind === "exceptions" && choose !== null) {
        const verdict = choose(raw);
        if (verdict !== null) {
          const say = live.current.t;
          if (verdict === "taken") show("ok", say("floor.exceptions.signal.taken"), null);
          else if (verdict === "not_sscc") show("error", say("floor.print.signal.notSscc"), null);
          else show("error", say("floor.exceptions.signal.notFound"), null);
          return;
        }
        // The choice was made or closed a moment ago: this scan is refused below, in words.
      }
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
        refuse(false, stopped.kind === "closed");
        return;
      }
      // A validation shift has no box to close first (plan РЕЖ).
      if (live.current.shift.copy.mode !== "validation") {
        await closeBox(true);
        if (stopRef.current !== null) {
          refuse(false);
          return;
        }
      }
      // A shift the office closed takes no new code: nothing is journalled.
      if (live.current.officeClosed) {
        refuse(false, false, true);
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
            // A label decided lets the next one that waits go (a box's, then its pallet's).
            if (stopRef.current === null) await settleLabel();
            await afterLabel();
          } catch (error) {
            if (error instanceof NoPrinterError) setLabelNote({ kind: "no_printer" });
            else if (error instanceof LabelRenderError) setLabelNote({ kind: "render_failed" });
            else if (error instanceof StaleJobError || error instanceof UnresolvableJobError) {
              // Not this decision's label any more: an intention to close after it ends.
              setPendingClose(null);
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

  /**
   * The operator's check of a job left `sending` whose final write failed:
   * the recovery of interrupted sends, as one piece of the line's work (the
   * queue holds no send of this app beside it; a send the runtime still holds
   * is left alone), then the job read again. Sends nothing.
   */
  const recoverStalled = async (job: PrintJob): Promise<PrintJob> => {
    await recoverInterruptedJobs(printContextOf(live));
    const now = live.current;
    const after = await readPrintJob(now.local, pairingOf(now), job.id);
    if (after === null) throw new StaleJobError(job.id);
    return after;
  };

  const decideAgain = (request: PrintAgain) =>
    decide(async (job) => {
      const now = live.current;
      const settings = await readWorkstationSettings(now.local);
      // A pallet's label is rendered again from the snapshot's pallet layout (plan ПЛ-Ц).
      const template =
        job.purpose === "pallet" && now.pallets !== null
          ? now.pallets.template
          : now.shift.snapshot.boxTemplate;
      return printAgain(printContextOf(live), job, request, settings, template, now.render);
    }, true);

  /** The settings the panel says a reprint's printer from (the same read `printAgain` makes). */
  const loadLabelSettings = useCallback(() => readWorkstationSettings(live.current.local), []);

  /** The shift's closed boxes into the open exceptions (the screen of a stop that has gone is left alone). */
  const showClosedBoxes = async (): Promise<void> => {
    const now = live.current;
    const boxes = await readClosedBoxes(now.local, pairingOf(now), now.shift.copy.id);
    const closedPallets =
      now.pallets === null
        ? null
        : await readClosedPallets(now.local, pairingOf(now), now.shift.copy.id);
    if (stopRef.current?.kind === "exceptions") {
      setStop({ kind: "exceptions", boxes, pallets: closedPallets });
    }
  };

  /**
   * The exceptions, opened while nothing stops the work: as the line's next
   * piece of work, so that the entry's own work has ended. A label that waits
   * is decided first — a box with a waiting label could be taken apart, and
   * the order of its panel is what keeps that from happening — so the panel
   * takes the screen instead; otherwise the shift's closed boxes are read.
   */
  /**
   * «Исключения» from the footer, or the open box's own «Снять последний код» /
   * «Очистить короб» (the cloud's box instrument), which open the same
   * exceptions on that action; the focus comes back to the button pressed.
   */
  const openExceptions = (from: ExceptionsOpener = "exceptions") => {
    if (leavingNow() || stopRef.current !== null) return;
    setExceptionsFrom(from);
    setStop({ kind: "exceptions", boxes: null, pallets: null });
    void live.current
      .track(
        queue.run(async () => {
          await settleSafely();
          if (stopRef.current?.kind === "exceptions") await showClosedBoxes();
        }),
      )
      .catch(() => {
        if (stopRef.current?.kind === "exceptions")
          setStop({ kind: "system_error", cause: "read" });
      });
  };

  /** Whether a label of the shift waits (read fresh, in the queue's turn). */
  const labelWaits = async (): Promise<boolean> => {
    const now = live.current;
    return (await readOpenJob(now.local, pairingOf(now), now.shift.copy.id)) !== null;
  };

  /**
   * An exception as the line's next piece of work, handed to the gate before
   * it starts: whatever it wrote goes to the host, a label that now waits is
   * settled (its panel takes the screen), the closed boxes and the numbers
   * are read again, and the screen says how it went. It never rejects: a
   * failure is said. Once the leave began it starts nothing.
   */
  const exception = (work: () => Promise<ExceptionOutcome>): Promise<ExceptionOutcome> => {
    if (leavingNow()) return Promise.resolve({ kind: "leaving" });
    return live.current.track(
      queue.run(async () => {
        // The screen the operator pressed in may be gone in the queue's turn (a label that
        // waits took it while this waited): the exception is not done, and the operator is told
        // over whatever stands now, never left to think it was.
        if (stopRef.current?.kind !== "exceptions") {
          const say = live.current.t;
          show(
            "error",
            say("floor.exceptions.signal.notDone"),
            say("floor.exceptions.signal.notDoneDetail"),
          );
          return { kind: "label_waiting" };
        }
        let outcome: ExceptionOutcome;
        try {
          outcome = await work();
        } catch (error) {
          outcome = outcomeOf(error);
        }
        // A failed one may have written all the same: the host is told, and learns nothing new if it did not.
        if (outcome.kind === "done" || outcome.kind === "label" || outcome.kind === "failed") {
          live.current.onRecorded();
        }
        await settleSafely();
        try {
          await showClosedBoxes();
          await refresh();
        } catch {
          // The numbers are read again with the next piece of work.
        }
        return outcome;
      }),
    );
  };

  /** A box's label printed again; a new label that waits is shown by the settling that follows. */
  const reprint = (boxId: string, reason: Parameters<typeof reprintBox>[2]) =>
    exception(async () => {
      if (await labelWaits()) return { kind: "label_waiting" };
      const now = live.current;
      const settings = await readWorkstationSettings(now.local);
      const job = await reprintBox(
        { ...printContextOf(live), shift: now.shift },
        boxId,
        reason,
        settings,
        now.render,
      );
      return isOpenJob(job) ? { kind: "label" } : { kind: "done", action: "reprint" };
    });

  /** A closed box taken apart, unless a label waits (the label's panel is decided first). */
  const disassemble = (boxId: string, reason: Parameters<typeof disassembleBox>[2]) =>
    exception(async () => {
      if (await labelWaits()) return { kind: "label_waiting" };
      const result = await disassembleBox(boxContextOf(live), boxId, reason);
      return result.kind === "done" ? { kind: "done", action: "disassemble" } : result;
    });

  /**
   * A closed pallet's label printed again with a reason (plan ПЛ-Ц), unless a
   * label waits (decided at its panel first); a new label that waits is shown
   * by the settling that follows.
   */
  const reprintThePallet = (palletId: string, reason: Parameters<typeof reprintPallet>[3]) =>
    exception(async () => {
      if (await labelWaits()) return { kind: "label_waiting" };
      const now = live.current;
      // The screen offers a pallet's exception only to a shift with pallets.
      if (now.pallets === null) return { kind: "unavailable" };
      const settings = await readWorkstationSettings(now.local);
      const job = await reprintPallet(
        { ...printContextOf(live), shift: now.shift },
        now.pallets,
        palletId,
        reason,
        settings,
        now.render,
      );
      return isOpenJob(job) ? { kind: "label" } : { kind: "done", action: "pallet_reprint" };
    });

  /**
   * A closed pallet taken apart (plan ПЛ-Ц). It cannot be undone, so the flow
   * has confirmed it with a reason before this runs; and never while any label
   * waits: a taken-apart pallet's waiting label could not be printed again
   * (every attempt would meet the pallet gone) and a failed one would still
   * be printed for it. A label that waits is decided at its panel first.
   */
  const disassembleThePallet = (
    palletId: string,
    reason: Parameters<typeof disassemblePallet>[2],
  ) =>
    exception(async () => {
      if (await labelWaits()) return { kind: "label_waiting" };
      const result = await disassemblePallet(boxContextOf(live), palletId, reason);
      return result.kind === "done" ? { kind: "done", action: "pallet_disassemble" } : result;
    });

  /**
   * «Закрыть паллету досрочно» (plan ПЛ-Ц): the open pallet closes with the
   * boxes it holds, after a label that waits is decided; when the pallet
   * serials ran out the host is asked for a block and the close tried once
   * more. What is left stops the work with its reason (`fromClose`: it was the
   * shift's close that asked, and the stop says the shift is not closed).
   * Answers how it went. Only from the work queue.
   */
  const closePallet = useCallback(
    async (fromClose = false): Promise<"closed" | "empty" | "stopped"> => {
      const now = live.current;
      const pallets = now.pallets;
      if (pallets === null) return "empty";
      // No screen flow reaches this check today: every caller arrives with no label waiting
      // (the early-close button is off under any stop, the shift's summary names `label` before
      // `open_pallet` and `sameSummary` re-reads it in the turn, the link-back calls this only
      // under `pallet_no_serials`). It still keeps `pendingClose`'s job id the pallet's own: after
      // this close the stop that holds is the label of the pallet just closed. A caller that
      // skips the summary must keep it.
      if ((await readOpenJob(now.local, pairingOf(now), now.shift.copy.id)) !== null) {
        await settleSafely();
        return "stopped";
      }
      // A serial that cannot label a pallet is lost and the next taken, up to three in a row,
      // as for a full pallet (plan ХП); a stale write is tried again inside each try.
      const close = () =>
        closeLosingBadSerials(() =>
          closeSettled(() => closeOpenPallet(palletContextOf(live), pallets)),
        );
      let result = await close();
      let supplied: SupplyResult | null = null;
      if (result.kind === "no_serials") {
        supplied = await palletSupply.topUp();
        if (supplied.kind === "stored") {
          live.current.onRecorded();
          result = await close();
        }
      }
      if (result.kind === "empty") return "empty";
      if (result.kind === "closed") {
        live.current.onRecorded();
        if (alive.current) setPalletWaits(null);
        await settleSafely();
        return "closed";
      }
      if (result.kind === "no_serials") {
        const reason =
          supplied === null || supplied.kind === "stored" || supplied.kind === "enough"
            ? "failed"
            : supplied.kind;
        setStop({ kind: "pallet_no_serials", reason, fromClose });
        return "stopped";
      }
      // Three serials in a row could not label a pallet (each lost: «Повторить» takes the
      // next), or the pallet changed under three tries: nothing was closed.
      setStop({ kind: "pallet_failed", fromClose });
      return "stopped";
    },
    [palletSupply, settleSafely, setStop],
  );

  /**
   * The summary of the close, read as the line's next piece of work: a scan
   * taken before «Закрыть смену» was pressed has been written by then, and
   * the summary counts it.
   */
  const readSummary = () =>
    queue.run(async () => {
      const now = live.current;
      await showSummary(await readCloseSummary(now.local, pairingOf(now), now.shift.copy.id), null);
    });

  /** «Закрыть смену», pressed while nothing stops the work: the summary first. */
  const openClose = () => {
    if (leavingNow() || stopRef.current !== null) return;
    setPlanReached(false);
    setStop({ kind: "close", summary: null, note: null, waitingSscc: null, attempt: 0 });
    void live.current
      .track(readSummary())
      .catch(() => setStop({ kind: "system_error", cause: "read" }));
  };

  /**
   * The close itself, as the line's next piece of work handed to the gate
   * before it starts, with no host: nothing queued before it is left behind
   * it, and a scan queued after it finds the closed stop. It closes on the
   * numbers the operator saw and on no others: the summary is read again in
   * the turn, and a different one is shown instead (the model checks it once
   * more inside its write: a change in between is `stale`, the same).
   * A write whose answer was lost is read back: a shift found closed is
   * closed, not an error. The reason is the operator's, from the buttons.
   * It is queued although the `close` stop already refuses every scan taken
   * after the press: that is defence in depth today (a queued scan is refused
   * in its turn either way). The pallet work of plan ПЛ-Ц queues before the
   * close, in the same turn (`confirmPalletClose`); the order is pinned by
   * «takes no scan queued behind the close: it meets the closed shift»
   * (`test/floor-work-close-pallets.test.tsx`), which holds a job that is not
   * a scan.
   */
  const confirmClose = (reason: ShiftCloseReasonCode | null) => {
    const before = stopRef.current;
    if (before?.kind !== "close" || before.summary === null) return;
    if (closeRunning.current || leavingNow()) return;
    const shown = before.summary;
    closeRunning.current = true;
    setClosing(true);
    void live.current
      .track(
        queue.run(async () => {
          try {
            const fresh = await readSummaryNow();
            // A shift found closed differs from the one shown, and is shown as closed.
            if (!sameSummary(shown, fresh)) {
              await showSummary(fresh, "stale");
              return;
            }
            await finishClose(reason, shown);
          } catch {
            await closeFailed(shown);
          } finally {
            closeRunning.current = false;
            if (alive.current) setClosing(false);
          }
        }),
      )
      .catch(() => setStop({ kind: "system_error", cause: "write" }));
  };

  /**
   * «Закрыть паллету и смену» (plan ПЛ-Ц; the cloud station's
   * `confirmShiftClosePallet`), as the line's next piece of work handed to the
   * gate before it starts, like `confirmClose`: the summary is read again in
   * the turn and a different one is shown instead of closing on what the
   * operator did not see; then the open pallet closes and its label goes, and
   * the shift closes with the reason chosen. A pallet label that waits — its
   * check, a printer that failed — takes the screen first, and the shift's
   * close follows once it is decided (`pendingClose`, `afterLabel`). No pallet
   * serial, or a serial out of range, stops the work with its reason, and the
   * shift stays open: the intention to close is not kept, the operator presses
   * again.
   */
  const confirmPalletClose = (reason: ShiftCloseReasonCode | null) => {
    const before = stopRef.current;
    if (before?.kind !== "close" || before.summary === null) return;
    if (closeRunning.current || leavingNow()) return;
    const shown = before.summary;
    closeRunning.current = true;
    setClosing(true);
    void live.current
      .track(
        queue.run(async () => {
          try {
            const fresh = await readSummaryNow();
            if (!sameSummary(shown, fresh)) {
              await showSummary(fresh, "stale");
              return;
            }
            const closed = await closePallet(true);
            // The explicit stop: the pallet did not close and `closePallet` left a stop of its
            // own (a label to decide, no serial, a lost serial). Without this line the shift's
            // close below would still be refused, but only by `closeShift`'s guards; do not
            // delete it because the suite stays green.
            if (closed === "stopped") return;
            const waiting = stopRef.current;
            if (waiting?.kind === "label") {
              // Tied to the label that stopped the work: the pallet's own, just closed.
              setPendingClose({ reason, shown, jobId: waiting.job.id });
              return;
            }
            await finishClose(reason, shown);
          } catch {
            await closeFailed(shown);
          } finally {
            closeRunning.current = false;
            if (alive.current) setClosing(false);
            // The summary's button is gone with the summary, which a stop of the pallet's
            // close replaced: the focus goes to a safe place, as after any answer.
            const stopped = stopRef.current?.kind;
            if (stopped === "pallet_no_serials" || stopped === "pallet_failed") refocus();
          }
        }),
      )
      .catch(() => setStop({ kind: "system_error", cause: "write" }));
  };

  // «Назад» from the summary of the close: the focus returns to the button that opened it.
  const summaryOpen = stop?.kind === "close";
  const summaryWas = useRef(false);
  useEffect(() => {
    if (summaryWas.current && !summaryOpen && stop === null) {
      actionsRef.current
        ?.querySelector<HTMLButtonElement>('[data-action="close-shift"]:not(:disabled)')
        ?.focus();
    }
    summaryWas.current = summaryOpen;
  }, [summaryOpen, stop]);

  // «Назад» from the exceptions: the focus returns to the button that opened them.
  const exceptionsOpen = stop?.kind === "exceptions";
  const exceptionsWere = useRef(false);
  useEffect(() => {
    if (exceptionsWere.current && !exceptionsOpen && stop === null) {
      const pick = (action: string) =>
        actionsRef.current?.querySelector<HTMLButtonElement>(
          `[data-action="${action}"]:not(:disabled)`,
        );
      (pick(exceptionsFrom) ?? pick("exceptions"))?.focus();
    }
    exceptionsWere.current = exceptionsOpen;
  }, [exceptionsOpen, stop, exceptionsFrom]);

  /** The work goes on, after the label that may wait is read again (its panel takes the screen). */
  const resumeWork = () => {
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

  /** The system error dismissed. */
  const dismissSystemError = () => {
    dismiss(() => setStop(null));
    resumeWork();
  };

  /** From the summary to the label that keeps the shift open: its panel decides it. */
  const toLabel = () => {
    setStop(null);
    resumeWork();
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
  // the label that waits is settled; a box the stopped station left full
  // closes first (kept open while a label waits); then a pallet it left full.
  useEffect(() => {
    void live.current
      .track(
        queue.run(async () => {
          await refresh();
          // Pallets that are missing stop the work before anything is written.
          if (stopRef.current?.kind === "pallets_missing") return;
          // A validation shift prints nothing and has no box (plan РЕЖ): nothing to recover,
          // settle or close.
          if (live.current.shift.copy.mode === "validation") return;
          try {
            await recoverInterruptedJobs(printContextOf(live));
          } catch {
            setStop({ kind: "system_error", cause: "label" });
            return;
          }
          await settleSafely();
          await closeBox(true);
          // A pallet a stop of the station left full closes now.
          if (stopRef.current === null) await settlePalletSafely();
          await refreshQuietly();
        }),
      )
      .catch(failSystem);
  }, [
    queue,
    refresh,
    refreshQuietly,
    settleSafely,
    settlePalletSafely,
    closeBox,
    failSystem,
    setStop,
  ]);

  // On entry and whenever the link is back: serials by the half rule; a close
  // that waited for them goes again.
  const online = props.online;
  useEffect(() => {
    // A validation shift numbers no box: it never asks for serials (plan РЕЖ).
    if (!online || validation) return;
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
  }, [online, validation, supply, queue, closeBox, refreshQuietly, setStop]);

  // Pallet serials by the half rule on entry and whenever the link is back (plan
  // ПЛ-Ц): a pallet that waited for them closes, and an early close that stopped
  // for them goes again.
  const hasPallets = pallets !== null;
  useEffect(() => {
    if (!online || !hasPallets) return;
    void live.current
      .track(
        Promise.resolve()
          .then(() => palletSupply.topUp())
          .then(async (topped) => {
            if (topped.kind !== "stored") return;
            live.current.onRecorded();
            await live.current.track(
              queue.run(async () => {
                const waiting = stopRef.current;
                try {
                  if (waiting?.kind === "pallet_no_serials") {
                    setStop(null);
                    await closePallet(waiting.fromClose);
                  } else if (waiting === null) {
                    await settlePallet();
                  }
                } catch {
                  setStop({ kind: "system_error", cause: "write" });
                }
                await refreshQuietly();
              }),
            );
          }),
      )
      .catch(() => undefined);
  }, [online, hasPallets, palletSupply, queue, closePallet, settlePallet, refreshQuietly, setStop]);

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

  /** «Закрыть паллету» confirmed (or «Повторить»): the early close as the line's next piece of work. */
  const closePalletNow = () => {
    // Nothing the operator presses starts work the leave no longer waits for.
    if (leavingNow()) return;
    // «Повторить» of a stop that the shift's close met keeps saying the shift is not closed.
    const was = stopRef.current;
    const fromClose =
      (was?.kind === "pallet_no_serials" || was?.kind === "pallet_failed") && was.fromClose;
    setStop(null);
    palletRefocus.current = true;
    void live.current
      .track(
        queue.run(async () => {
          await closePallet(fromClose);
          await refreshQuietly();
        }),
      )
      .catch(() => setStop({ kind: "system_error", cause: "write" }))
      // The button pressed is gone, and the pallet it closed may be too.
      .finally(refocus);
  };

  // The operator who asked to close an incomplete box or pallet has the safe answer under their hand.
  const confirming = stop?.kind === "confirm_close";
  const confirmingPallet = stop?.kind === "confirm_pallet";
  useEffect(() => {
    if (confirming || confirmingPallet) confirmRef.current?.querySelector("button")?.focus();
  }, [confirming, confirmingPallet]);

  /** The operator answers a message: what it held the focus with goes, and the focus goes somewhere safe. */
  const dismiss = (answer: () => void) => {
    answer();
    refocus();
  };

  const openBox = totals?.openBox ?? null;
  const items = openBox?.itemCount ?? 0;
  const canClose = items > 0 && stop === null && !leaving;
  const palletBoxes = pallet?.boxCount ?? 0;
  // The waiting message follows what `refresh` reads: with no open pallet, or one below
  // its capacity (it closed, or a box was taken off it), nothing waits any more.
  const palletWaitsNow =
    pallet !== null && pallets !== null && pallet.boxCount >= pallets.capacity ? palletWaits : null;
  // A stage of the work takes the place of the instruments (the cloud's exceptions do):
  // the exceptions, the close and its end, a label that waits. The instruments stay
  // mounted under it, out of reach, so that the last scan still says what became of a scan.
  const staged =
    stop?.kind === "exceptions" ||
    stop?.kind === "close" ||
    stop?.kind === "closed" ||
    stop?.kind === "label";
  const planFact = {
    term: t("floor.work.plan"),
    value: plannedQty === null ? t("floor.work.noPlan") : formatQuantity(plannedQty),
  };
  // A validation shift has no box to count (plan РЕЖ): its figures are in its panel.
  const facts = validation
    ? [planFact]
    : [
        { term: t("floor.work.closedBoxes"), value: formatQuantity(totals?.closedBoxes ?? 0) },
        planFact,
        ...(totals !== null && totals.lastSscc !== null
          ? [{ term: t("floor.work.lastSscc"), value: formatSsccHri(totals.lastSscc) }]
          : []),
      ];
  /** A stop's card over the work: the cloud's overlay alert, its action row under the words. */
  const card = (
    tone: "ok" | "warn" | "error",
    title: string,
    body: ReactNode,
    actions: ReactNode = null,
  ) => (
    <Alert
      tone={tone}
      role="presentation"
      className="work-overlay"
      title={<span className="work-overlay__title">{title}</span>}
    >
      <div className="work-overlay__body">
        {body}
        {actions !== null && <div className="work-overlay__actions">{actions}</div>}
      </div>
    </Alert>
  );
  /** «Повторить» of a stop: on the keyboard while the leave waits, and a press that does nothing. */
  const retry = (onClick: () => void) => (
    <Button
      size="floor"
      variant="secondary"
      aria-disabled={leaving ? true : undefined}
      style={leaving ? WAITING_STYLE : undefined}
      onClick={onClick}
    >
      {t("floor.work.retry")}
    </Button>
  );

  return (
    // A `section`: the app's shell owns the page's `main`.
    <section
      className="work-screen"
      aria-label={t("floor.work.title", { number: shift.copy.number })}
      ref={actionsRef}
    >
      <div className="work-screen__content">
        {/* Under a stage the instruments are out of reach (`inert`), and still say the last scan. */}
        <div className="work-screen__work" inert={staged}>
          <ShiftBand
            productName={shift.snapshot.product.name}
            gtin={shift.snapshot.product.gtin14}
            number={shift.copy.number}
            counterpartyName={shift.snapshot.counterpartyName}
            accepted={totals?.accepted ?? 0}
            plannedQty={plannedQty}
          />
          {officeClosed && stop?.kind !== "closed" && (
            <Alert tone="warn" title={t("floor.work.officeClosed.title")}>
              {t("floor.work.officeClosed.body")}
            </Alert>
          )}
          <div className="work-screen__instruments">
            <div className="work-screen__primary">
              {validation ? (
                <ValidationPanel
                  accepted={totals?.accepted ?? 0}
                  duplicates={counts?.duplicates ?? 0}
                  errors={counts?.errors ?? 0}
                  plannedQty={plannedQty}
                  outcomes={outcomes}
                />
              ) : (
                <BoxFill
                  items={items}
                  capacity={capacity}
                  acceptedToken={last?.kind === "accepted" ? (totals?.accepted ?? 0) : 0}
                  actions={
                    <>
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
                      {/*
                      The cloud's box instrument: the open box's two exceptions under it, the
                      same actions as their cards (gone under a stage, which has them itself).
                    */}
                      {!staged && (
                        <>
                          <Button
                            size="floor"
                            variant="secondary"
                            data-action="box-undo"
                            disabled={!canClose}
                            onClick={() => openExceptions("box-undo")}
                          >
                            {t("floor.exceptions.actions.undo")}
                          </Button>
                          <Button
                            size="floor"
                            variant="secondary"
                            data-action="box-clear"
                            disabled={!canClose}
                            onClick={() => openExceptions("box-clear")}
                          >
                            {t("floor.exceptions.actions.clear")}
                          </Button>
                        </>
                      )}
                    </>
                  }
                />
              )}
              {pallets !== null && (
                <PalletStrip
                  boxCount={palletBoxes}
                  capacity={pallets.capacity}
                  closeDisabled={palletBoxes === 0 || stop !== null || leaving}
                  onClose={() => setStop({ kind: "confirm_pallet" })}
                  warning={
                    palletWaitsNow === null
                      ? null
                      : {
                          title: t("floor.work.palletWaits.title"),
                          body: t(
                            palletWaitsNow === "invalid"
                              ? "floor.work.palletWaits.invalid"
                              : "floor.work.palletWaits.body",
                          ),
                        }
                  }
                />
              )}
            </div>
            <div className="work-screen__secondary">
              {/*
                A refusal is announced by its flash (an alert); this line keeps every
                verdict in words, and an accepted scan lights it for a moment (the tone
                and the counts carry the rest: no overlay, no announcement per scan).
              */}
              <LastScan
                text={last === null ? t("floor.work.waiting") : lastText(last, t, capacity)}
                tone={lastTone(last)}
                cued={cued}
                lineRef={lastRef}
              />
              <WorkFacts facts={facts} />
            </div>
          </div>
        </div>
      </div>
      <FloorFooter
        className={validation ? "work-footer work-footer--two" : "work-footer"}
        ariaLabel={t(validation ? "floor.validation.actions" : "floor.work.layout.actions")}
      >
        {/* A validation shift has no exceptions (plan РЕЖ, Р9: the cloud's are its boxes'). */}
        {!validation && (
          <FooterAction
            variant="secondary"
            data-action="exceptions"
            disabled={stop !== null || leaving}
            onClick={() => openExceptions()}
          >
            {t("floor.exceptions.open")}
          </FooterAction>
        )}
        {/* On the keyboard while the leave waits: `aria-disabled`, and a press that does nothing. */}
        <FooterAction
          variant="warning-outline"
          aria-disabled={leaving ? true : undefined}
          style={leaving ? WAITING_STYLE : undefined}
          onClick={leaving ? undefined : onLeave}
        >
          {t("floor.work.leave")}
        </FooterAction>
        <FooterAction
          variant="destructive-outline"
          data-action="close-shift"
          disabled={stop !== null || leaving}
          onClick={openClose}
        >
          {t("floor.close.open")}
        </FooterAction>
      </FloorFooter>
      {/*
        The stops and notices share one polite region that is on the screen
        before any of them, so each is heard once, when it comes; the alerts
        lose their own role (`presentation`) for that reason. A stage of the
        work sits in it too, over the instruments.
      */}
      <div className="work-screen__overlays work-screen__alerts" aria-live="polite">
        {stop?.kind === "system_error" &&
          card(
            "error",
            t(`floor.work.systemError.${stop.cause}.title`),
            <p>{t(`floor.work.systemError.${stop.cause}.body`)}</p>,
            <Button size="floor" variant="secondary" onClick={dismissSystemError}>
              {t("floor.work.systemError.dismiss")}
            </Button>,
          )}
        {stop?.kind === "no_serials" &&
          card(
            "warn",
            t("floor.work.noSerials.title"),
            <p>
              {t(
                stop.reason === "offline" && linkHeld
                  ? "floor.work.noSerials.held"
                  : `floor.work.noSerials.${stop.reason}`,
              )}
            </p>,
            retry(() => closeNow(stop.full)),
          )}
        {stop?.kind === "close_failed" &&
          card(
            "error",
            t("floor.work.closeFailed.title"),
            <p>{t(`floor.work.closeFailed.${stop.cause}`)}</p>,
            retry(() => closeNow(stop.full)),
          )}
        {stop?.kind === "pallets_missing" &&
          card(
            "error",
            t("floor.work.palletsMissing.title"),
            <p>{t("floor.work.palletsMissing.body")}</p>,
          )}
        {stop?.kind === "pallet_no_serials" &&
          card(
            "warn",
            t("floor.work.palletNoSerials.title"),
            <>
              <p>
                {t(
                  stop.reason === "offline" && linkHeld
                    ? "floor.work.palletNoSerials.held"
                    : `floor.work.palletNoSerials.${stop.reason}`,
                )}
              </p>
              {stop.fromClose && <p>{t("floor.work.palletShiftOpen")}</p>}
            </>,
            retry(closePalletNow),
          )}
        {stop?.kind === "pallet_failed" &&
          card(
            "error",
            t("floor.work.palletFailed.title"),
            <>
              <p>{t("floor.work.palletFailed.body")}</p>
              {stop.fromClose && <p>{t("floor.work.palletShiftOpen")}</p>}
            </>,
            retry(closePalletNow),
          )}
        {planReached &&
          card(
            "ok",
            t("floor.work.planReached", {
              quantity: formatQuantity(totals?.accepted ?? 0),
              planned: formatQuantity(plannedQty ?? 0),
            }),
            null,
            <>
              {/* A validation shift is offered its close at the plan, as at the cloud station. */}
              {validation && (
                <Button
                  size="floor"
                  aria-disabled={leaving || stop !== null ? true : undefined}
                  style={leaving || stop !== null ? WAITING_STYLE : undefined}
                  onClick={openClose}
                >
                  {t("floor.validation.closeShift")}
                </Button>
              )}
              <Button
                size="floor"
                variant="secondary"
                onClick={() => dismiss(() => setPlanReached(false))}
              >
                {t("floor.work.continue")}
              </Button>
            </>,
          )}
        {waitingSerials && (
          <p className="work-overlay--note work-screen__waiting">
            {t("floor.work.waitingSerials")}
          </p>
        )}
        {sending && (
          <p className="work-overlay--note work-screen__waiting">{t("floor.print.sending")}</p>
        )}
        {stop?.kind === "exceptions" && (
          <div className="work-screen__stage">
            <ExceptionFlow
              openItems={items}
              boxes={stop.boxes}
              onUndo={() =>
                exception(async () =>
                  openBoxOutcome(await undoLastCode(boxContextOf(live)), "undo"),
                )
              }
              onClear={() =>
                exception(async () =>
                  openBoxOutcome(await clearOpenBox(boxContextOf(live)), "clear"),
                )
              }
              onReprint={reprint}
              onDisassemble={disassemble}
              {...(pallets === null
                ? {}
                : {
                    pallets: stop.pallets,
                    onPalletReprint: reprintThePallet,
                    onPalletDisassemble: disassembleThePallet,
                  })}
              loadSettings={loadLabelSettings}
              {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
              registerScan={registerScan}
              onTextEntry={textEntry}
              onBack={() => setStop(null)}
              {...(exceptionsFrom === "box-undo"
                ? { start: "undo" as const }
                : exceptionsFrom === "box-clear"
                  ? { start: "clear" as const }
                  : {})}
              {...(props.labelClock === undefined ? {} : { clock: props.labelClock })}
            />
          </div>
        )}
        {stop?.kind === "close" && (
          <div className="work-screen__stage" data-centred="true">
            <ShiftClosePanel
              number={shift.copy.number}
              productName={shift.snapshot.product.name}
              summary={stop.summary}
              note={stop.note}
              waitingSscc={stop.waitingSscc}
              attempt={stop.attempt}
              busy={closing}
              onClose={confirmClose}
              onBack={() => setStop(null)}
              onLabel={toLabel}
              palletCapacity={pallets?.capacity ?? null}
              onClosePallet={confirmPalletClose}
              boxless={validation}
              {...(props.labelClock === undefined ? {} : { clock: props.labelClock })}
            />
          </div>
        )}
        {stop?.kind === "closed" && (
          <div className="work-screen__stage" data-centred="true">
            <ShiftClosedPanel
              number={shift.copy.number}
              record={stop.record}
              linkHeld={linkHeld}
              leaving={leaving}
              onDone={onLeave}
              boxless={validation}
              {...(props.labelClock === undefined ? {} : { clock: props.labelClock })}
            />
          </div>
        )}
        {stop?.kind === "label" && (
          <div className="work-screen__stage work-screen__label-stage" data-centred="true">
            {closeAfterLabel && (
              <p className="work-overlay--note work-screen__waiting">
                {t("floor.close.afterLabel")}
              </p>
            )}
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
              checkQueue={() => props.printing.checkWindowsJob(stop.job.id)}
              {...(stop.job.state === "sending" && !props.printing.isInFlight(stop.job.id)
                ? { onRecover: () => decide(recoverStalled, false) }
                : {})}
              {...(props.onSetup === undefined ? {} : { onSetup: props.onSetup })}
              {...(props.labelClock === undefined ? {} : { clock: props.labelClock })}
            />
          </div>
        )}
      </div>
      {(confirming || confirmingPallet) && (
        <div className="work-screen__overlays">
          {confirming && (
            <div ref={confirmRef}>
              {card(
                "warn",
                t("floor.work.confirmClose", {
                  quantity: formatQuantity(items),
                  capacity: formatQuantity(capacity),
                }),
                null,
                <>
                  <Button
                    size="floor"
                    variant="secondary"
                    onClick={() => dismiss(() => setStop(null))}
                  >
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
                </>,
              )}
            </div>
          )}
          {confirmingPallet && (
            <div ref={confirmRef}>
              {card(
                "warn",
                t("floor.work.confirmPallet", {
                  quantity: formatQuantity(palletBoxes),
                  capacity: formatQuantity(pallets?.capacity ?? 0),
                }),
                null,
                <>
                  <Button
                    size="floor"
                    variant="secondary"
                    onClick={() =>
                      dismiss(() => {
                        palletRefocus.current = true;
                        setStop(null);
                      })
                    }
                  >
                    {t("floor.work.keepPallet")}
                  </Button>
                  <Button
                    size="floor"
                    aria-disabled={leaving ? true : undefined}
                    style={leaving ? WAITING_STYLE : undefined}
                    onClick={closePalletNow}
                  >
                    {t("floor.work.closePallet")}
                  </Button>
                </>,
              )}
            </div>
          )}
        </div>
      )}
      {/* Always on the screen, so that the text put into it is announced. */}
      <p className="work-screen__leaving" aria-live="polite">
        {leaving ? t("floor.work.leaving") : ""}
      </p>
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
    </section>
  );
}
