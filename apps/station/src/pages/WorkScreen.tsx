import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  classifyScan,
  validateShiftScan,
  type LabelTemplateSpec,
  type ScanVerdict,
} from "@markiro/domain";
import { Alert, Button, FullScreenDialog, SignalOverlay, type SignalTone } from "@markiro/ui";
import { boxLabelFields } from "../lib/box-label.js";
import { attemptBoxPrint } from "../lib/box-printing.js";
import {
  boxOrdinal,
  clearBox,
  currentBox,
  disassembleBox,
  findUnresolvedBoxPrint,
  listClosedBoxes,
  markBoxPrinted,
  markBoxPrintFailed,
  markPrintSkipped,
  markPrintVerified,
  openBox,
  reprintBox,
  type ClosedBoxSummary,
  type DeviceBox,
  type UnresolvedBoxPrint,
} from "../lib/boxes.js";
import { closeCurrentBox as closeCurrentBoxLib, type CloseBoxResult } from "../lib/close-box.js";
import type { PrintTarget } from "../lib/hardware.js";
import type { PrinterLanguage } from "../lib/hardware-config.js";
import {
  findFirstSeen,
  findLatestAcceptedOperation,
  listRecentOperations,
  loadCodeKeys,
  recordScan,
  undoLastScan,
  type RecentOperation,
} from "../lib/journal.js";
import { applyMigrations, readShiftMirror, type SqlExecutor } from "../lib/mirror.js";
import { renderLabelBytes } from "../lib/print-label.js";
import { rasterizeText } from "../lib/rasterizer.js";
import { createScanQueue, type ScanOutcome, type ScanQueue } from "../lib/scan-queue.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { OfflineShiftCloseSummary } from "../lib/shift-close.js";
import { playSignalTone, type SoundSettings } from "../lib/signal-sound.js";
import { PrintVerification } from "../ui/PrintVerification.js";
import { BoxPrintRecovery, type BoxPrintRecoveryErrorCode } from "../ui/BoxPrintRecovery.js";
import { BoxFillInstrument } from "../ui/work/BoxFillInstrument.js";
import { RecentOperations } from "../ui/work/RecentOperations.js";
import { ScanResultInstrument } from "../ui/work/ScanResultInstrument.js";
import type { StationProductImageDescriptor } from "../lib/mirror.js";
import { WorkCounters } from "../ui/work/WorkCounters.js";
import { WorkFooter } from "../ui/work/WorkFooter.js";
import { buildWorkLabels } from "../ui/work/work-labels.js";
import { ExceptionFlow } from "./ExceptionFlow.js";

export interface WorkScreenProps {
  exec: SqlExecutor;
  shiftId: string;
  terminalId: string | null;
  operatorId: string;
  expectedGtin14: string;
  productName: string;
  productId?: string;
  productImage?: StationProductImageDescriptor | null | undefined;
  counterpartyName?: string | null;
  /** Human-readable shift number for the box label's `shift.no` field. */
  shiftNumber?: string | null;
  plannedQty?: number | null | undefined;
  source: ScanSource;
  sound: SoundSettings;
  /** Signals a scan was just written, so a queued outbox row does not have
   * to wait for the sync engine's 15s heartbeat before draining. */
  onScanRecorded?: () => void;
  /** Registers the ordered scan/job queue with App's credential-recovery barrier. */
  onScanQueueRegister?: (queue: ScanQueue) => () => void;
  /** Return to shift selection. Does NOT close the shift — that is a cabinet action. */
  onExit: () => void;
  /** Persists a local close and queues it for the server. */
  onCloseShift?: (reasonCode?: string | null) => Promise<OfflineShiftCloseSummary>;
  /** Scans still queued on this device, shown before the operator walks away. */
  pendingSync: number;
  /**
   * This device's 9-digit GS1 issuer prefix for box SSCCs
   * (`StationBundle.sscc.issuerPrefix`), or null for a validation-mode
   * shift, or when the server could not resolve one for this device. Null
   * means the box UI does not render at all — there is nothing to close.
   */
  issuerPrefix: string | null;
  /** Items per box before it closes automatically (the shift's `boxCapacity`). */
  boxCapacity: number | null;
  /** Bumps after a freshly downloaded bundle replaces the offline mirror. */
  bundleRevision?: number;
  /**
   * Injectable for tests; defaults to the real `closeCurrentBox` (Task 12)
   * bound to this device's `issuerPrefix`.
   */
  closeCurrentBox?: (shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>;
  /** Fires for every raw payload the scan queue processes, whatever the verdict — test-only observability. */
  onScan?: (raw: string) => void;
  /** Opt-in per workstation: scan a closed box's printed label back before moving on. */
  verifyPrintedLabel: boolean;
  /** Where and how to render + send a box label. Omit to skip printing (e.g. no printer configured). */
  printing?: {
    target: PrintTarget;
    language: PrinterLanguage;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  /** Opens the existing workstation setup without resolving the durable print job. */
  onOpenPrinterSetup?: () => void;
  /** Publishes the fail-closed state to App's operator/window/update controls. */
  onPrintRecoveryChange?: (blocked: boolean) => void;
}

export type WorkBlockingState = "serial-exhaustion";
export type WorkOverlayState = "exit-pending" | "clear-confirm";

/** How long each verdict's full-screen flash stays up (design brief 04). */
const FLASH_MS: Record<SignalTone, number> = { ok: 350, error: 1200, duplicate: 900 };

interface RecentReadState {
  mounted: boolean;
  active: boolean;
  trailing: boolean;
}

function toneOf(verdict: ScanVerdict): SignalTone {
  if (verdict.status === "ok") return "ok";
  if (verdict.status === "duplicate") return "duplicate";
  return "error";
}

export function WorkScreen({
  exec,
  shiftId,
  terminalId,
  operatorId,
  expectedGtin14,
  productName,
  productId,
  productImage,
  counterpartyName,
  shiftNumber,
  plannedQty,
  source,
  sound,
  onScanRecorded,
  onScanQueueRegister,
  onExit,
  onCloseShift,
  pendingSync,
  issuerPrefix,
  boxCapacity,
  bundleRevision = 0,
  closeCurrentBox: closeCurrentBoxProp,
  onScan,
  verifyPrintedLabel,
  printing,
  onOpenPrinterSetup,
  onPrintRecoveryChange,
}: WorkScreenProps) {
  const { t, i18n } = useTranslation();
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [signal, setSignal] = useState<{ tone: SignalTone; title: string; detail?: string } | null>(
    null,
  );
  const signalContext = useRef({ sound, t });
  signalContext.current = { sound, t };
  const [confirmExit, setConfirmExit] = useState(false);
  const [closeReasonPicker, setCloseReasonPicker] = useState(false);
  const [closeReason, setCloseReason] = useState<string>("production_defect");
  const [closeError, setCloseError] = useState<string | null>(null);
  const closeRequestRef = useRef(false);
  const [closeRequestPending, setCloseRequestPending] = useState(false);
  const [planReachedPrompt, setPlanReachedPrompt] = useState<number | null>(null);
  const planReachedPromptRef = useRef(false);
  const planReachedAcknowledgedRef = useRef(false);
  const [showExceptions, setShowExceptions] = useState(false);
  const [recentOperations, setRecentOperations] = useState<RecentOperation[]>([]);
  const [imageRefreshKey, setImageRefreshKey] = useState(0);
  useEffect(() => {
    const first = window.setTimeout(() => setImageRefreshKey((key) => key + 1), 300);
    const second = window.setTimeout(() => setImageRefreshKey((key) => key + 1), 1_000);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [shiftId]);
  const [latestAcceptedOperation, setLatestAcceptedOperation] = useState<RecentOperation | null>(
    null,
  );
  const recentReadState = useRef<RecentReadState>({
    mounted: false,
    active: false,
    trailing: false,
  });
  const latestAcceptedReadState = useRef<RecentReadState>({
    mounted: false,
    active: false,
    trailing: false,
  });

  const refreshRecentOperations = useCallback((): void => {
    const state = recentReadState.current;
    if (!state.mounted) return;
    if (state.active) {
      state.trailing = true;
      return;
    }
    state.active = true;
    void listRecentOperations(exec, shiftId)
      .then((rows) => {
        // If another scan committed while this read was active, its trailing
        // read owns the visible result. Do not briefly publish this older
        // snapshot before that read starts.
        if (recentReadState.current === state && state.mounted && !state.trailing) {
          setRecentOperations(rows);
        }
      })
      .catch((err: unknown) => {
        if (recentReadState.current === state && state.mounted) {
          console.error("station: failed to read recent scan operations", err);
        }
      })
      .finally(() => {
        if (recentReadState.current !== state || !state.mounted) return;
        state.active = false;
        if (state.trailing) {
          state.trailing = false;
          refreshRecentOperations();
        }
      });
  }, [exec, shiftId]);

  const refreshLatestAcceptedOperation = useCallback((): void => {
    const state = latestAcceptedReadState.current;
    if (!state.mounted) return;
    if (state.active) {
      state.trailing = true;
      return;
    }
    state.active = true;
    void findLatestAcceptedOperation(exec, shiftId)
      .then((operation) => {
        if (latestAcceptedReadState.current === state && state.mounted && !state.trailing) {
          setLatestAcceptedOperation(operation);
        }
      })
      .catch((err: unknown) => {
        if (latestAcceptedReadState.current === state && state.mounted) {
          console.error("station: failed to read latest accepted scan", err);
        }
      })
      .finally(() => {
        if (latestAcceptedReadState.current !== state || !state.mounted) return;
        state.active = false;
        if (state.trailing) {
          state.trailing = false;
          refreshLatestAcceptedOperation();
        }
      });
  }, [exec, shiftId]);

  useEffect(() => {
    const state: RecentReadState = { mounted: true, active: false, trailing: false };
    recentReadState.current = state;
    refreshRecentOperations();
    return () => {
      state.mounted = false;
      state.trailing = false;
    };
  }, [refreshRecentOperations]);

  useEffect(() => {
    const state: RecentReadState = { mounted: true, active: false, trailing: false };
    latestAcceptedReadState.current = state;
    refreshLatestAcceptedOperation();
    return () => {
      state.mounted = false;
      state.trailing = false;
    };
  }, [refreshLatestAcceptedOperation]);

  // Box aggregation state -- null (never loaded / no `issuerPrefix`) means no
  // box UI at all, per Task 13's correction: a validation-mode shift, or a
  // device the server could not resolve an issuer prefix for, has no box
  // section to show.
  const [box, setBox] = useState<{ boxId: string; itemCount: number } | null>(null);
  const [boxNumber, setBoxNumber] = useState<number | null>(null);
  const [lastScanned, setLastScanned] = useState<{
    boxId: string;
    codeHash: string;
    scannedAt: string;
  } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [closedBoxes, setClosedBoxes] = useState<ClosedBoxSummary[]>([]);
  // `boxRef` is the box's SOURCE OF TRUTH for `process()` below, updated by
  // `updateBox` synchronously and directly -- never derived from `box` via a
  // separate effect. A scan can arrive (and be judged) the instant this
  // screen mounts, before React has committed the box-loading effect's
  // state update and re-run any effect that merely mirrors it; `updateBox`
  // closes that gap by writing the ref at the exact moment the box changes,
  // with `setBox` alongside it purely to drive the on-screen display.
  const boxRef = useRef<{ boxId: string; itemCount: number } | null>(null);
  const updateBox = useCallback((next: { boxId: string; itemCount: number } | null): void => {
    const previousBoxId = boxRef.current?.boxId ?? null;
    boxRef.current = next;
    setBox(next);
    if ((next?.boxId ?? null) !== previousBoxId) setLastScanned(null);
  }, []);
  // Resolves once the current box has been loaded (or opened, or -- with no
  // `issuerPrefix` -- decided there is none) so `process()` can await it the
  // same way it already awaits `keysReady`, instead of racing a scan that
  // arrives before this screen's mount effects have settled.
  const boxReady = useRef<Promise<void> | null>(null);

  const reloadClosedBoxes = useCallback(async (): Promise<void> => {
    try {
      setClosedBoxes(await listClosedBoxes(exec, shiftId, terminalId));
    } catch (err) {
      console.error("station: failed to list closed boxes", err);
    }
  }, [exec, shiftId, terminalId]);

  const ensureCurrentBox = useCallback(async (): Promise<void> => {
    const existing = await currentBox(exec, shiftId);
    if (existing) {
      const ordinal = await boxOrdinal(exec, shiftId, existing.terminalId, existing.boxId);
      setBoxNumber(ordinal);
      updateBox({ boxId: existing.boxId, itemCount: existing.itemCount });
      return;
    }
    const boxId = crypto.randomUUID();
    await openBox(exec, shiftId, boxId, new Date().toISOString(), terminalId);
    const ordinal = await boxOrdinal(exec, shiftId, terminalId, boxId);
    setBoxNumber(ordinal);
    updateBox({ boxId, itemCount: 0 });
  }, [exec, shiftId, terminalId, updateBox]);

  useEffect(() => {
    if (issuerPrefix === null) {
      setClosedBoxes([]);
      return;
    }
    void reloadClosedBoxes();
  }, [issuerPrefix, reloadClosedBoxes]);

  const [noSerials, setNoSerials] = useState(false);
  // The box label's geometry -- a plain ref, not React state, the same shape
  // `keys` (above) already takes: nothing renders off this, and
  // the print-recovery attempt reads it from inside `closeTheBox`, which can
  // itself run from `process()` -- a scan handler awaited well before React
  // has necessarily re-rendered this component, so a value that only
  // updated via `setState` could still read stale here regardless of
  // `labelSpecReady` below (Task 13 review, Finding 4). Written
  // synchronously inside the SAME `.then()` that resolves `labelSpecReady`,
  // so awaiting that promise guarantees this ref already holds whatever the
  // load produced, regardless of render timing.
  const labelSpecRef = useRef<LabelTemplateSpec | null>(null);
  // Resolves once this device's box-label geometry has been loaded (or
  // decided there is none, with no `issuerPrefix`) -- the same `keysReady`/
  // `boxReady` pattern this file already uses twice (Task 13 review, Finding
  // 4). The print attempt awaits this before deciding whether a print
  // happened: without it, a box that closes before this mount-time
  // `readShiftMirror` resolves (a very fast first box, e.g. `boxCapacity: 1`)
  // would race a still-null `labelSpecRef`, silently skip printing, and --
  // now that Finding 3 makes a non-print visible -- show "print unavailable"
  // for a label that would have printed fine a moment later.
  const labelSpecReady = useRef<Promise<void> | null>(null);
  type PrintRecoveryState = Omit<UnresolvedBoxPrint, "errorCode"> & {
    errorCode: BoxPrintRecoveryErrorCode;
    pending: boolean;
  };
  const [printRecovery, setPrintRecoveryState] = useState<PrintRecoveryState | null>(null);
  const printRecoveryRef = useRef<PrintRecoveryState | null>(null);
  const updatePrintRecovery = useCallback((next: PrintRecoveryState | null): void => {
    printRecoveryRef.current = next;
    setPrintRecoveryState(next);
  }, []);
  // This seal spans the gap between a durable close and the successful
  // opening of its successor box. Recovery state alone is too short-lived:
  // an immediately successful print clears it while the close queue entry is
  // still draining, allowing an already-delivered native scan callback to
  // journal against no box. The ref closes admission synchronously; state
  // publishes the same block to App and the visible source subscription.
  const [printAdmissionBlocked, setPrintAdmissionBlockedState] = useState(issuerPrefix !== null);
  const printAdmissionBlockedRef = useRef(issuerPrefix !== null);
  const updatePrintAdmissionBlocked = useCallback((blocked: boolean): void => {
    printAdmissionBlockedRef.current = blocked;
    setPrintAdmissionBlockedState(blocked);
  }, []);
  const [printRecoveryHydrated, setPrintRecoveryHydrated] = useState(issuerPrefix === null);
  const [printRecoveryHydrationFailed, setPrintRecoveryHydrationFailed] = useState(false);
  const [printRecoveryHydrationEpoch, setPrintRecoveryHydrationEpoch] = useState(0);
  const [printRecoveryRetrying, setPrintRecoveryRetrying] = useState(false);
  const printRecoveryRetryingRef = useRef(false);
  const printRecoveryHydratedRef = useRef(issuerPrefix === null);
  printRecoveryHydratedRef.current = printRecoveryHydrated;
  const printRecoveryReady = useRef<Promise<boolean> | null>(null);
  const printingRef = useRef(printing);
  printingRef.current = printing;

  const retryPrintRecoveryHydration = useCallback((): void => {
    if (printRecoveryRetryingRef.current) return;
    printRecoveryRetryingRef.current = true;
    setPrintRecoveryRetrying(true);
    void applyMigrations(exec)
      .catch(() => {
        console.error("station: print recovery migration retry failed");
      })
      .finally(() => {
        setPrintRecoveryHydrationEpoch((epoch) => epoch + 1);
        printRecoveryRetryingRef.current = false;
        setPrintRecoveryRetrying(false);
      });
  }, [exec]);
  // Keep verification as a queue because exception reprints can add work
  // while an earlier printed label is still unresolved. Ordinary box intake
  // is now blocked by the first prompt, but no secondary entry may overwrite
  // it if another legitimate print path produces one.
  const [verificationQueue, setVerificationQueue] = useState<
    Array<{
      sscc: string;
      itemCount: number;
      bytes: Uint8Array | null;
      boxId: string | null;
    }>
  >([]);
  const verificationBlockedRef = useRef(false);
  /** The one prompt currently shown, or null when the queue is empty. */
  const verification = verificationQueue[0] ?? null;
  function enqueueVerification(entry: {
    sscc: string;
    itemCount: number;
    bytes: Uint8Array | null;
    boxId: string | null;
  }): void {
    verificationBlockedRef.current = true;
    setVerificationQueue((q) => [...q, entry]);
  }
  /** Drops the currently-shown prompt, revealing the next queued one (if any). */
  function dequeueVerification(): void {
    setVerificationQueue((q) => {
      const remaining = q.slice(1);
      verificationBlockedRef.current = remaining.length > 0;
      return remaining;
    });
  }
  // Mirrors `verification` on every render (a plain assignment, not an
  // effect, so it is already current by the time anything reads it after
  // this commit) -- the same "read the latest value through a ref instead
  // of closing over state" trick `live` below uses, needed here so
  // `handleVerified` can have a STABLE identity across renders while still
  // seeing the current box id.
  const verificationRef = useRef(verification);
  verificationRef.current = verification;
  // CodeRabbit PR33 review, Finding 9: serializes every `printing.print(...)`
  // call -- a native/hardware call with no serialization of its own -- so
  // overlapping recovery and exception-reprint actions can never send two
  // labels to the printer concurrently, which
  // could arrive out of order or fail on a busy serial port. Deliberately
  // scoped to ONLY the printer call, not the whole print-and-verify flow:
  // scanning itself (and rendering each box's own label bytes) must stay
  // non-blocking, and only the shared printer resource needs exclusive
  // access. A promise chain, not a lock flag: each job attaches to the
  // TAIL of whatever is already queued, and the tail is always renormalized
  // to a non-rejecting promise so one job's failure (already handled by its
  // own caller) never poisons the chain for jobs queued after it.
  const printQueueRef = useRef<Promise<void>>(Promise.resolve());
  function serializePrint<T>(job: () => Promise<T>): Promise<T> {
    const started = printQueueRef.current.then(job);
    printQueueRef.current = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  // Ref-based in-flight guard around `closeTheBox`, mirroring `boxRef` above:
  // checked and set synchronously, before any `await`, so a double-tap of
  // the manual close button -- or a tap racing an auto-close the very same
  // accepted scan triggers via `refreshBoxAndMaybeClose` -- cannot run the
  // close path twice concurrently. Without this, both calls burn a serial
  // and print a label each, and the box's stored SSCC ends up as whichever
  // write lands second (Task 13 review, Finding 2). `closing` (state, not
  // the ref) exists only to disable the button visually -- a re-render
  // lands too late to prevent the second call by itself, which is why the
  // ref is what actually closes the race.
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [boxActionPending, setBoxActionPending] = useState(false);
  // Render-time guard for callbacks already handed to physical scan sources.
  // Effect cleanup cannot revoke a callback synchronously: a source may invoke
  // the old function after this render commits but before the passive cleanup
  // runs (or even after cleanup if native delivery was already queued). Keep
  // the current blocking state in a ref so those stale callbacks are harmless.
  const ordinaryScanBlockedRef = useRef(false);
  ordinaryScanBlockedRef.current = Boolean(
    !printRecoveryHydrated ||
    printAdmissionBlocked ||
    verification ||
    printRecovery ||
    confirmClear ||
    boxActionPending ||
    showExceptions ||
    closeReasonPicker ||
    closeRequestPending ||
    planReachedPrompt !== null ||
    noSerials,
  );

  function requestExit() {
    if (ordinaryScanBlockedRef.current) return;
    if (pendingSync > 0) setConfirmExit(true);
    else onExit();
  }

  async function performClose(reasonCode?: string | null): Promise<void> {
    if (!onCloseShift || closeRequestRef.current) return;
    closeRequestRef.current = true;
    ordinaryScanBlockedRef.current = true;
    setCloseRequestPending(true);
    setCloseError(null);
    try {
      await new Promise<void>((resolve, reject) => {
        const accepted = queue.enqueueJob(async () => {
          try {
            await onCloseShift(reasonCode ?? null);
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        if (!accepted) reject(new Error("station scan queue is closed"));
      });
      setCloseReasonPicker(false);
      onExit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already closed")) onExit();
      else if (message.includes("reason")) setCloseReasonPicker(true);
      else setCloseError(message.includes("open box") ? t("work.closeOpenBox") : message);
    } finally {
      closeRequestRef.current = false;
      setCloseRequestPending(false);
    }
  }

  async function requestClose(reasonCode?: string | null): Promise<void> {
    if (ordinaryScanBlockedRef.current) return;
    await performClose(reasonCode);
  }

  async function confirmPlanClose(): Promise<void> {
    if (!onCloseShift) return;
    planReachedPromptRef.current = false;
    setPlanReachedPrompt(null);
    await performClose(null);
  }

  // The domain's isDuplicate(key) is synchronous, so the device's accepted keys
  // are held in memory and updated on every insert rather than queried per scan.
  const keys = useRef<Set<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredSignalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredSoundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signalGeneration = useRef(0);

  /**
   * Blocking visual and audio feedback share this single tone argument so the
   * two channels cannot drift. Callers that already played the tone can opt
   * out of replaying it. A generation check is deliberately retained in
   * addition to clearTimeout: it also protects a newer verdict if an older
   * callback was already queued when the replacement signal arrived.
   */
  const showTimedSignal = useCallback(
    (tone: SignalTone, title: string, detail?: string, options?: { playSound?: boolean }): void => {
      const generation = ++signalGeneration.current;
      if (options?.playSound !== false) playSignalTone(tone, signalContext.current.sound);
      setSignal({ tone, title, ...(detail === undefined ? {} : { detail }) });
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        if (signalGeneration.current !== generation) return;
        flashTimer.current = null;
        setSignal(null);
      }, FLASH_MS[tone]);
    },
    [],
  );

  const publishVerdict = useCallback(
    (verdict: ScanVerdict, title: string, detail?: string): void => {
      const tone = toneOf(verdict);
      playSignalTone(tone, signalContext.current.sound);
      if (tone === "ok") return;
      showTimedSignal(tone, title, detail, { playSound: false });
    },
    [showTimedSignal],
  );

  /**
   * Box recovery can finish inside the accepted scan's process callback.
   * Defer its error until after that callback publishes the ordinary OK
   * verdict, otherwise the later OK would hide the more important recovery
   * failure before the operator ever sees it.
   */
  function showDeferredError(title: string): void {
    if (deferredSignalTimer.current) clearTimeout(deferredSignalTimer.current);
    deferredSignalTimer.current = setTimeout(() => {
      deferredSignalTimer.current = null;
      showTimedSignal("error", title);
    }, 0);
  }

  // The duplicate index must be in memory before the first scan is judged.
  // The scan source starts listening immediately (so nothing is missed) and
  // the queue serialises, so awaiting the load here simply makes the first
  // scan wait rather than validating against an empty set — which would
  // wrongly accept an already-known code. Even then, codes_mirror's PRIMARY
  // KEY is the backstop: recordScan reports that as `alreadyPresent` and the
  // verdict is corrected below, rather than the write failing outright.
  const keysReady = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resilient by construction: `keysReady` is awaited before every scan is
    // judged, so if this promise ever REJECTED, every later scan would await
    // a rejected promise and vanish silently forever. A failed load instead
    // falls back to an empty index — codes_mirror's PRIMARY KEY is still the
    // real backstop against duplicates (see journal.ts's recordScan), and now
    // correctly yields a `duplicate` verdict instead of a lost scan.
    keysReady.current = loadCodeKeys(exec)
      .then((loaded) => {
        if (!cancelled) keys.current = loaded;
      })
      .catch((err) => {
        console.error("station: failed to load accepted code keys", err);
        if (!cancelled) keys.current = new Set();
      });
    return () => {
      cancelled = true;
    };
  }, [exec]);

  // Restore durable label work before a fresh box or product intake can be
  // admitted. A pending row without a recorded category means the process
  // stopped between atomic close and classification; it remains manual retry
  // work rather than being printed automatically after restart.
  useEffect(() => {
    if (issuerPrefix === null) {
      setPrintRecoveryHydrationFailed(false);
      updatePrintRecovery(null);
      updatePrintAdmissionBlocked(false);
      printRecoveryHydratedRef.current = true;
      setPrintRecoveryHydrated(true);
      printRecoveryReady.current = Promise.resolve(false);
      return;
    }
    let cancelled = false;
    let hydrationSucceeded = false;
    setPrintRecoveryHydrationFailed(false);
    updatePrintAdmissionBlocked(true);
    printRecoveryHydratedRef.current = false;
    setPrintRecoveryHydrated(false);
    printRecoveryReady.current = findUnresolvedBoxPrint(
      exec,
      shiftId,
      terminalId,
      verifyPrintedLabel,
    )
      .then(async (unresolved) => {
        if (cancelled) return true;
        if (!unresolved) {
          updatePrintRecovery(null);
          boxReady.current = ensureCurrentBox();
          await boxReady.current;
          if (!cancelled) updatePrintAdmissionBlocked(false);
        } else if (unresolved.state === "printed") {
          updatePrintRecovery(null);
          enqueueVerification({
            sscc: unresolved.sscc,
            itemCount: unresolved.itemCount,
            bytes: null,
            boxId: unresolved.boxId,
          });
        } else {
          updatePrintRecovery({
            ...unresolved,
            errorCode: unresolved.errorCode ?? "interrupted",
            pending: false,
          });
        }
        hydrationSucceeded = true;
        return unresolved !== null;
      })
      .catch(() => {
        if (!cancelled) {
          console.error("station: failed to restore box print recovery");
          setPrintRecoveryHydrationFailed(true);
        }
        return true;
      })
      .finally(() => {
        if (!cancelled) {
          printRecoveryHydratedRef.current = hydrationSucceeded;
          setPrintRecoveryHydrated(hydrationSucceeded);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    ensureCurrentBox,
    exec,
    issuerPrefix,
    printRecoveryHydrationEpoch,
    shiftId,
    terminalId,
    updatePrintAdmissionBlocked,
    updatePrintRecovery,
    verifyPrintedLabel,
  ]);

  // Loads this shift's current open box, or opens a fresh one when this
  // device can aggregate (`issuerPrefix` present) but none is open yet --
  // e.g. the very first scan of an aggregation shift. Nothing is loaded or
  // opened when `issuerPrefix` is null: that is the "no box UI at all" state
  // (Task 13's correction), not a race to paper over.
  useEffect(() => {
    if (issuerPrefix === null) {
      updatePrintAdmissionBlocked(false);
      updateBox(null);
      setBoxNumber(null);
      boxReady.current = Promise.resolve();
      return;
    }
    if (!printRecoveryHydrated || printRecovery || verification) {
      updateBox(null);
      setBoxNumber(null);
      boxReady.current = Promise.resolve();
      return;
    }
    let cancelled = false;
    boxReady.current = ensureCurrentBox()
      .then(() => {
        if (!cancelled) updatePrintAdmissionBlocked(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error("station: failed to load or open the current box", err);
      });
    return () => {
      cancelled = true;
    };
  }, [
    ensureCurrentBox,
    issuerPrefix,
    printRecoveryHydrated,
    printRecovery,
    verification,
    updatePrintAdmissionBlocked,
    updateBox,
  ]);

  // The box label's geometry -- only needed when this device can print a box
  // label at all. A missing or unparsable spec degrades to "skip printing"
  // rather than a crash (see `attemptRecoveryPrint` below). No `issuerPrefix`
  // needs no gate at all: there is no box UI, so nothing will ever await
  // `labelSpecReady` in the first place, but it is still resolved (to a
  // no-op) for the same reason `boxReady` is -- a stray future await must
  // never hang forever.
  useEffect(() => {
    // A refreshed bundle may remove the template. Clear first so a failed,
    // absent, or unparsable replacement never leaves the previous spec live.
    labelSpecRef.current = null;
    if (issuerPrefix === null) {
      labelSpecReady.current = Promise.resolve();
      return;
    }
    let cancelled = false;
    labelSpecReady.current = readShiftMirror(exec, shiftId)
      .then((row) => {
        // CodeRabbit PR33 review, Finding 3: this is the BOX label's own
        // template spec (`box_label_template_spec`), never
        // `row.labelTemplateSpec` -- that is the ITEM template, mirrored from
        // a completely separate `shift.labelTemplateId`. Reading the item
        // spec here used to print the wrong label on every box (or nothing
        // at all, when only a box template was configured and the item one
        // was left unset).
        if (cancelled || !row?.boxLabelTemplateSpec) return;
        try {
          // Written synchronously, in the same tick this `.then()` runs, so
          // `attemptRecoveryPrint` sees it the instant `labelSpecReady`
          // resolves rather than waiting on a React re-render (see
          // `labelSpecRef`'s own doc comment).
          labelSpecRef.current = JSON.parse(row.boxLabelTemplateSpec) as LabelTemplateSpec;
        } catch (err) {
          console.error("station: failed to parse the box label template spec", err);
        }
      })
      .catch((err: unknown) => {
        console.error("station: failed to read the shift mirror for the box label spec", err);
      });
    return () => {
      cancelled = true;
    };
  }, [exec, shiftId, issuerPrefix, bundleRevision]);

  function fieldsForClosedBox(result: { sscc: string; itemCount: number }): Record<string, string> {
    return boxLabelFields({
      sscc: result.sscc,
      itemCount: result.itemCount,
      productName,
      gtin14: expectedGtin14,
      operatorName: null,
      counterpartyName: counterpartyName ?? null,
      closedAt: new Date().toISOString(),
      shiftNumber: shiftNumber ?? null,
    });
  }

  async function attemptClosedBoxPrint(result: { sscc: string; itemCount: number }) {
    await labelSpecReady.current;
    const currentPrinting = printingRef.current;
    return attemptBoxPrint({
      template: labelSpecRef.current,
      fields: fieldsForClosedBox(result),
      printing: currentPrinting
        ? {
            ...currentPrinting,
            print: (target, bytes) => serializePrint(() => currentPrinting.print(target, bytes)),
          }
        : null,
      render: (template, fields, language) =>
        renderLabelBytes(template, fields, language, rasterizeText),
    });
  }

  async function attemptRecoveryPrint(job: PrintRecoveryState): Promise<void> {
    updatePrintRecovery({ ...job, pending: true });
    const attempt = await attemptClosedBoxPrint(job);

    if (attempt.kind === "failed") {
      try {
        await markBoxPrintFailed(exec, job.boxId, attempt.code);
      } catch {
        console.error("station: failed to persist box print category");
      }
      updatePrintRecovery({ ...job, errorCode: attempt.code, pending: false });
      return;
    }

    try {
      await markBoxPrinted(exec, job.boxId);
    } catch {
      console.error("station: failed to persist printed box label");
      updatePrintRecovery({ ...job, errorCode: "transport_failed", pending: false });
      return;
    }
    updatePrintRecovery(null);
    if (verifyPrintedLabel) {
      enqueueVerification({
        sscc: job.sscc,
        itemCount: job.itemCount,
        bytes: attempt.bytes,
        boxId: job.boxId,
      });
    }
    void reloadClosedBoxes();
  }

  async function printExceptionLabel(
    result: { sscc: string; itemCount: number },
    boxId: string,
  ): Promise<void> {
    const attempt = await attemptClosedBoxPrint(result);
    if (attempt.kind === "printed" && verifyPrintedLabel) {
      enqueueVerification({
        sscc: result.sscc,
        itemCount: result.itemCount,
        bytes: attempt.bytes,
        boxId,
      });
    }
  }

  /**
   * Closes the current box, manually (the button) or automatically (capacity
   * reached). Never attempts anything when `issuerPrefix` is null -- pushed
   * all the way down here too, not just at the button's render gate, so a
   * programmatic call can never silently invent a fallback prefix either
   * (Task 13's correction).
   *
   * Guarded by `closingRef` (Task 13 review, Finding 2), checked and set
   * synchronously before the first `await`: the manual button is not
   * otherwise serialized against an auto-close the very same accepted scan
   * can trigger via `refreshBoxAndMaybeClose`, and a double-tap (or a tap
   * racing that auto-close) could otherwise run this twice concurrently --
   * both calls would burn a serial and print a label each, and the box's
   * stored SSCC would end up as whichever write lands second.
   */
  function reserveClose(): string | null {
    if (issuerPrefix === null || closingRef.current) return null;
    closingRef.current = true;
    setClosing(true);
    return issuerPrefix;
  }

  function releaseClose(): void {
    closingRef.current = false;
    setClosing(false);
  }

  async function performReservedClose(reservedIssuerPrefix: string): Promise<void> {
    try {
      // `boxRef.current`, not the `box` state variable: this file's own
      // comments on `boxRef` document that `box` can lag a `process()`-driven
      // close (a scan can update the ref before React has committed the
      // matching state update), and this is exactly the situation that
      // matters here -- reading a stale `box` would record the verification
      // against the WRONG box id (or null), and the `if (boxId)` guard around
      // `markPrintVerified`/`markPrintSkipped` would then silently drop the
      // record entirely (Task 13 review, Finding 4).
      const closingBoxId = boxRef.current?.boxId ?? null;
      const impl =
        closeCurrentBoxProp ??
        ((sid: string, operatorId: string | null) =>
          closeCurrentBoxLib({ exec, issuerPrefix: reservedIssuerPrefix }, sid, operatorId));

      let result: CloseBoxResult;
      try {
        result = await impl(shiftId, operatorId);
      } catch (err) {
        console.error("station: closeCurrentBox failed", err);
        return;
      }

      if (result.status === "empty") return;
      if (result.status === "no-serials") {
        setNoSerials(true);
        if (deferredSoundTimer.current) clearTimeout(deferredSoundTimer.current);
        deferredSoundTimer.current = setTimeout(() => {
          deferredSoundTimer.current = null;
          playSignalTone("error", signalContext.current.sound);
        }, 0);
        return;
      }
      if (result.status === "invalid-serial") {
        showDeferredError(signalContext.current.t("box.invalidSerial"));
        return;
      }

      setNoSerials(false);
      if (!closingBoxId) {
        console.error("station: closed box identity unavailable for print recovery");
        return;
      }
      updatePrintAdmissionBlocked(true);
      // Scans that arrived while this close was in flight belong to neither
      // the closed box nor a not-yet-open next box. Keep ordered side-channel
      // jobs, but reject those buffered product scans before recovery begins.
      queue.discardBufferedScans();
      updateBox(null);
      setBoxNumber(null);
      void reloadClosedBoxes();
      await attemptRecoveryPrint({
        boxId: closingBoxId,
        sscc: result.sscc,
        itemCount: result.itemCount,
        state: "pending",
        errorCode: "transport_failed",
        pending: false,
      });
    } finally {
      releaseClose();
    }
  }

  /** Auto-close already runs inside the ordered scan queue. */
  async function closeTheBox(): Promise<void> {
    const reservedIssuerPrefix = reserveClose();
    if (reservedIssuerPrefix === null) return;
    await performReservedClose(reservedIssuerPrefix);
  }

  /** Manual admission reserves synchronously so a double-tap cannot queue two closes. */
  function enqueueManualClose(): void {
    const reservedIssuerPrefix = reserveClose();
    if (reservedIssuerPrefix === null) return;
    if (!queue.enqueueJob(() => performReservedClose(reservedIssuerPrefix))) releaseClose();
  }

  /**
   * Re-reads the box's authoritative item count after an accepted, boxed
   * scan -- `currentBox`'s COUNT(*) already excludes items the sync engine
   * displaced out from under this device (Task 9/10), which a naive local
   * increment would not. Closes the box once capacity is reached.
   */
  async function refreshBoxAndMaybeClose(boxId: string): Promise<void> {
    let updated: DeviceBox | null;
    try {
      updated = await currentBox(exec, shiftId);
    } catch (err) {
      console.error("station: failed to refresh the current box", err);
      return;
    }
    // The box moved on under us (e.g. already closed by another path) --
    // nothing to reconcile here.
    if (!updated || updated.boxId !== boxId) return;
    updateBox({ boxId: updated.boxId, itemCount: updated.itemCount });
    if (boxCapacity !== null && updated.itemCount >= boxCapacity) {
      await closeTheBox();
    }
  }

  // `t`, `i18n.language`, `sound`, `onScanRecorded` and `onScan` all change
  // over the life of one mounted WorkScreen (a language switch, a
  // mute/volume change in setup, a fresh callback identity from App on every
  // render), and `refreshBox` closes over box/print/verification state and
  // props that change too -- but the queue below must NOT be recreated when
  // any of them do: `source.start(...)` (further down) is bound to one queue
  // instance, and a fresh queue has its own buffer and `draining` flag — if
  // the `useMemo` depended on these values, a change would leave the old
  // queue's buffer (still fed by the bound source) draining concurrently
  // with a brand new queue, breaking the "exactly one scan in flight"
  // guarantee the whole pipeline rests on. So `process`/`onOutcome`/
  // `onError` read the current values through this ref instead of closing
  // over the props/hooks directly.
  const live = useRef({
    t,
    language: i18n.language,
    sound,
    onScanRecorded,
    onScan,
    operatorId,
    refreshBox: refreshBoxAndMaybeClose,
    refreshRecentOperations,
    refreshLatestAcceptedOperation,
    plannedQty,
  });
  useEffect(() => {
    live.current = {
      t,
      language: i18n.language,
      sound,
      onScanRecorded,
      onScan,
      operatorId,
      refreshBox: refreshBoxAndMaybeClose,
      refreshRecentOperations,
      refreshLatestAcceptedOperation,
      plannedQty,
    };
  });

  const queue = useMemo(
    () =>
      createScanQueue({
        shouldProcess: () =>
          printRecoveryHydratedRef.current &&
          !printAdmissionBlockedRef.current &&
          printRecoveryRef.current === null &&
          !verificationBlockedRef.current,
        async process(raw): Promise<ScanOutcome> {
          // Test-only observability that the scan loop keeps running --
          // called unconditionally, before anything about the box's state is
          // even looked at, so a bug that stops labelling from also stopping
          // scanning (Task 13's "no-serials" floor rule) cannot hide behind
          // it never firing.
          live.current.onScan?.(raw);

          await keysReady.current;
          // Awaited before `boxRef` is read below, the same reasoning as
          // `keysReady`: this screen's box-loading effect starts an async
          // load/open the instant it mounts, and a scan can arrive before
          // that settles. Without this, such a scan would be judged against
          // a still-null `boxRef` and land with no box at all, exactly the
          // gap `boxReady` exists to close.
          await boxReady.current;
          const verdict = validateShiftScan(raw, {
            expectedGtin14,
            isDuplicate: (key) => keys.current.has(key),
          });
          const scannedAt = new Date().toISOString();
          const event = {
            shiftId,
            terminalId,
            raw,
            verdict: verdict.status,
            scannedAt,
            operatorId: live.current.operatorId,
          };
          const boxId = boxRef.current?.boxId ?? null;

          if (verdict.status === "ok") {
            const scan = classifyScan(raw);
            // `ok` is only produced for a parsed KM, so this branch always holds.
            const km = scan.kind === "km" ? scan.km : null;
            const codeHash = km ? verdict.key : null;
            const result = await recordScan(
              exec,
              event,
              km && codeHash
                ? {
                    codeHash,
                    shiftId,
                    gtin14: km.gtin14,
                    serial: km.serial,
                    scannedAt,
                    boxId,
                  }
                : null,
            );
            if (result.alreadyPresent && codeHash) {
              // The in-memory duplicate index missed this one; codes_mirror's
              // PRIMARY KEY is the real backstop (see journal.ts's recordScan
              // doc comment), so the verdict is corrected here instead of
              // reporting a false accept.
              keys.current.add(codeHash);
              const firstSeen = await findFirstSeen(exec, codeHash);
              return { raw, verdict: { status: "duplicate", key: codeHash }, firstSeen };
            }
            if (codeHash) keys.current.add(codeHash);
            // Awaited HERE, inside process(): the queue drains strictly one
            // scan at a time (see scan-queue.ts's doc comment), so this is
            // the only place a box's count-then-maybe-close can run without
            // racing the very next scan for the same box. A close now keeps
            // this ordered path blocked until print recovery is resolved or
            // handed to the operator, so buffered scans cannot cross it.
            if (codeHash && boxId !== null) {
              setLastScanned({ boxId, codeHash, scannedAt });
              await live.current.refreshBox(boxId);
            }
            const plannedQty = live.current.plannedQty;
            const planReached =
              plannedQty !== null &&
              plannedQty !== undefined &&
              !planReachedAcknowledgedRef.current &&
              (
                await exec.all<{ actualQty: number }>(
                  "SELECT COUNT(*) AS actualQty FROM codes_mirror WHERE shift_id = ?",
                  [shiftId],
                )
              )[0]?.actualQty === plannedQty;
            if (planReached) planReachedPromptRef.current = true;
            return { raw, verdict, firstSeen: null, ...(planReached ? { planReached } : {}) };
          }

          await recordScan(exec, event, null);
          const firstSeen =
            verdict.status === "duplicate" ? await findFirstSeen(exec, verdict.key) : null;
          return { raw, verdict, firstSeen };
        },
        onOutcome(outcome) {
          const { t: liveT, language, onScanRecorded: liveOnScanRecorded } = live.current;
          if (outcome.verdict.status === "ok") setAccepted((n) => n + 1);
          else setRejected((n) => n + 1);

          const title =
            outcome.verdict.status === "ok"
              ? liveT("signal.ok")
              : outcome.verdict.status === "duplicate"
                ? liveT("signal.duplicate")
                : outcome.verdict.status === "wrong_gtin"
                  ? liveT("signal.wrongGtin")
                  : liveT("signal.wrongCode");
          const detail =
            outcome.firstSeen === null
              ? undefined
              : liveT("signal.firstSeen", {
                  time: new Intl.DateTimeFormat(language.startsWith("ru") ? "ru-RU" : "en-US", {
                    timeStyle: "medium",
                  }).format(new Date(outcome.firstSeen)),
                });

          publishVerdict(outcome.verdict, title, detail);

          // Nudged last, strictly after the operator-visible signal is
          // rendered: `process()` above already wrote this outcome's outbox
          // row (every branch calls `recordScan`, whatever the verdict), so
          // the sync engine has real work to nudge for either way, and
          // `nudge()` cannot throw synchronously -- but the operator's
          // feedback must stay ahead of background sync work regardless.
          liveOnScanRecorded?.();
          // The journal commit and sync nudge remain the scan queue's critical
          // path. This display-only read is deliberately detached so a slow
          // mirror query cannot delay intake or the next queued scan.
          void live.current.refreshRecentOperations();
          if (outcome.verdict.status === "ok") {
            void live.current.refreshLatestAcceptedOperation();
            if (outcome.planReached) setPlanReachedPrompt(live.current.plannedQty ?? null);
          }
        },
        onError() {
          // A throw from process() (e.g. the journal write) must never leave
          // the operator with silence: they scanned something and need SOME
          // signal, distinct from an ordinary rejection, so they know to
          // rescan rather than assume the code was accepted.
          console.error("station: scan write failed", { category: "journal_write" });
          setRejected((n) => n + 1);
          const { t: liveT } = live.current;
          showTimedSignal("error", liveT("signal.systemError"));
        },
        onJobError() {
          const { t: liveT } = live.current;
          showTimedSignal("error", liveT("signal.systemError"));
        },
      }),
    [exec, shiftId, terminalId, expectedGtin14, publishVerdict, showTimedSignal],
  );

  function handleUndo(): Promise<void> {
    const target = lastScanned;
    if (!target) return Promise.reject(new Error("last scan is no longer available"));
    return enqueueExceptionJob(async () => {
      await undoLastScan(exec, {
        boxId: target.boxId,
        codeHash: target.codeHash,
        scannedAt: target.scannedAt,
        shiftId,
        terminalId,
        operatorId,
        at: new Date().toISOString(),
      });
      setLastScanned(null);
      keys.current.delete(target.codeHash);
      await live.current.refreshBox(target.boxId);
      live.current.onScanRecorded?.();
    });
  }

  function clearCurrentBox(): Promise<void> {
    const boxId = boxRef.current?.boxId;
    if (!boxId) return Promise.reject(new Error("open box is no longer available"));
    return enqueueExceptionJob(async () => {
      const clearedCodes = await exec.all<{ code_hash: string }>(
        "SELECT code_hash FROM codes_mirror WHERE box_id = ?",
        [boxId],
      );
      await clearBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId,
        at: new Date().toISOString(),
      });
      setLastScanned(null);
      for (const code of clearedCodes) keys.current.delete(code.code_hash);
      await live.current.refreshBox(boxId);
      live.current.onScanRecorded?.();
    });
  }

  function confirmClearBox(): void {
    setConfirmClear(false);
    void clearCurrentBox();
  }

  function enqueueExceptionJob(job: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const accepted = queue.enqueueJob(async () => {
        try {
          await job();
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      });
      if (!accepted) reject(new Error("station correction queue is closed"));
    });
  }

  function handleReprint(boxId: string, reason: string): Promise<void> {
    const target = closedBoxes.find((candidate) => candidate.boxId === boxId);
    if (!target) return Promise.reject(new Error("closed box is no longer available"));
    return enqueueExceptionJob(async () => {
      await reprintBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId,
        reason,
        at: new Date().toISOString(),
      });
      void printExceptionLabel({ sscc: target.sscc, itemCount: target.itemCount }, boxId);
      await reloadClosedBoxes();
      live.current.onScanRecorded?.();
    });
  }

  function handleDisassemble(boxId: string, reason: string): Promise<void> {
    const target = closedBoxes.find((candidate) => candidate.boxId === boxId);
    if (!target) return Promise.reject(new Error("closed box is no longer available"));
    return enqueueExceptionJob(async () => {
      const releasedCodes = await exec.all<{ code_hash: string }>(
        "SELECT code_hash FROM codes_mirror WHERE box_id = ?",
        [boxId],
      );
      await disassembleBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId,
        reason,
        at: new Date().toISOString(),
      });
      for (const code of releasedCodes) keys.current.delete(code.code_hash);
      await reloadClosedBoxes();
      live.current.onScanRecorded?.();
    });
  }

  // Registration owns the intake lifecycle too. Closing first prevents a
  // source callback racing unmount from adding work after recovery's barrier
  // snapshot; unregister only after every scan/job accepted before close has
  // settled. `open()` makes StrictMode's setup -> cleanup -> setup cycle safe
  // even though useMemo deliberately preserves this one queue instance.
  useEffect(() => {
    queue.open();
    const unregister = onScanQueueRegister?.(queue);
    return () => {
      void queue.close().then(
        () => unregister?.(),
        () => unregister?.(),
      );
    };
  }, [onScanQueueRegister, queue]);

  // Paused while print verification is up: that scan source is reading the
  // box label's SSCC, not a product KM, and feeding it into this ordinary
  // queue would misjudge it as an invalid code and flash an error signal
  // over the verification prompt -- the one place a scan verdict is allowed
  // to compete with anything is print verification itself, not a stray
  // rejection from the loop underneath it.
  useEffect(() => {
    if (verification || confirmClear || boxActionPending || showExceptions) return;
    // Keep the physical source subscribed while serial recovery owns the
    // screen, but deliberately discard its payloads. A keyboard-wedge source
    // must still preventDefault() on its terminating Enter; unsubscribing it
    // would let that Enter activate the dialog's focused recovery button and
    // dismiss a blocking state without an intentional operator action.
    if (printRecovery || noSerials) return source.start(() => {});
    return source.start((raw) => {
      if (!printRecoveryHydratedRef.current) {
        void printRecoveryReady.current?.then((recoveryBlocked) => {
          if (!recoveryBlocked && !printAdmissionBlockedRef.current && !printRecoveryRef.current) {
            queue.enqueue(raw);
          }
        });
        return;
      }
      if (ordinaryScanBlockedRef.current) return;
      if (planReachedPromptRef.current) return;
      queue.enqueue(raw);
    });
  }, [
    source,
    queue,
    verification,
    printRecovery,
    printRecoveryHydrated,
    noSerials,
    confirmClear,
    boxActionPending,
    showExceptions,
  ]);

  const printBlocked =
    issuerPrefix !== null &&
    (!printRecoveryHydrated ||
      printAdmissionBlocked ||
      printRecovery !== null ||
      verification !== null);
  const recoveryCallbackRef = useRef(onPrintRecoveryChange);
  recoveryCallbackRef.current = onPrintRecoveryChange;
  useEffect(() => {
    recoveryCallbackRef.current?.(printBlocked);
  }, [printBlocked]);
  useEffect(
    () => () => {
      recoveryCallbackRef.current?.(false);
    },
    [],
  );

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (deferredSignalTimer.current) clearTimeout(deferredSignalTimer.current);
      if (deferredSoundTimer.current) clearTimeout(deferredSoundTimer.current);
    },
    [],
  );

  // Stable across renders (Task 13 review, "also fix, cheap"): `PrintVerification`
  // lists this in its own scan-subscription effect's deps, so a fresh arrow
  // here on every unrelated re-render (a sync-drain tick, a signal flash
  // timing out) would tear down and re-establish that subscription mid-
  // verification, risking a lost scan during the async re-subscribe. Reads
  // the current box id through `verificationRef` (see above) rather than
  // closing over `verification` directly, which is what lets this have a
  // stable identity in the first place.
  const handleVerified = useCallback((): Promise<boolean> => {
    const boxId = verificationRef.current?.boxId ?? null;
    // The outcome is an ordered queue job, so credential recovery waits it
    // alongside accepted scans and box/correction work. Keep the existing
    // console reporting: a locked DB must not become an unhandled rejection.
    if (!boxId) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const accepted = queue.enqueueJob(async () => {
        try {
          const won = await markPrintVerified(exec, boxId, new Date().toISOString());
          if (won) {
            dequeueVerification();
            void reloadClosedBoxes();
          }
          resolve(won);
        } catch {
          console.error("station: recording print verification failed");
          resolve(false);
        }
      });
      if (!accepted) resolve(false);
    });
  }, [exec, queue, reloadClosedBoxes]);

  function retryPrintRecovery(): void {
    const job = printRecoveryRef.current;
    if (!job || job.pending) return;
    if (!queue.enqueueJob(() => attemptRecoveryPrint(job))) {
      console.error("station: box print retry was not admitted");
    }
  }

  function skipPrintRecovery(): void {
    const job = printRecoveryRef.current;
    if (!job || job.pending) return;
    updatePrintRecovery({ ...job, pending: true });
    const admitted = queue.enqueueJob(async () => {
      try {
        const won = await markPrintSkipped(exec, job.boxId, new Date().toISOString());
        if (won) {
          updatePrintRecovery(null);
          void reloadClosedBoxes();
          live.current.onScanRecorded?.();
        } else {
          updatePrintRecovery({ ...job, pending: false });
        }
      } catch {
        console.error("station: recording box print skip failed");
        updatePrintRecovery({ ...job, pending: false });
      }
    });
    if (!admitted) {
      console.error("station: box print skip was not admitted");
      updatePrintRecovery({ ...job, pending: false });
    }
  }

  const workLabels = buildWorkLabels(t, i18n.language, boxNumber);
  const blockingState: WorkBlockingState | null = noSerials ? "serial-exhaustion" : null;
  const overlayState: WorkOverlayState | null = confirmExit
    ? "exit-pending"
    : confirmClear
      ? "clear-confirm"
      : null;

  return (
    <main className="work-screen" aria-label={productName}>
      <div className="work-screen__content">
        {showExceptions ? (
          <ExceptionFlow
            boxes={closedBoxes}
            canUndo={lastScanned?.boxId === box?.boxId}
            hasOpenBox={box !== null}
            onUndo={handleUndo}
            onClear={clearCurrentBox}
            onReprint={handleReprint}
            onDisassemble={handleDisassemble}
            onBack={() => setShowExceptions(false)}
            onPendingChange={setBoxActionPending}
          />
        ) : (
          <div className="work-screen__instruments">
            <div className="work-screen__primary">
              <ScanResultInstrument
                productName={productName}
                counterpartyName={counterpartyName ?? null}
                plannedQty={plannedQty}
                planLabel={t("work.plan")}
                operation={latestAcceptedOperation}
                labels={workLabels.status}
                exec={exec}
                productId={productId}
                image={productImage}
                refreshKey={imageRefreshKey}
              />
              {issuerPrefix !== null ? (
                <BoxFillInstrument
                  box={box}
                  ordinal={boxNumber}
                  acceptedToken={
                    lastScanned !== null && lastScanned.boxId === box?.boxId
                      ? `${lastScanned.codeHash}:${lastScanned.scannedAt}`
                      : null
                  }
                  capacity={boxCapacity}
                  canUndo={lastScanned?.boxId === box?.boxId}
                  closeDisabled={closing}
                  labels={workLabels.box}
                  onClose={enqueueManualClose}
                  onUndo={() => void handleUndo()}
                  onClear={() => setConfirmClear(true)}
                />
              ) : null}
            </div>
            <aside className="work-screen__secondary" aria-label={workLabels.summary}>
              <WorkCounters
                accepted={accepted}
                rejected={rejected}
                pendingSync={pendingSync}
                locale={workLabels.locale}
                labels={workLabels.counters}
              />
              <RecentOperations
                operations={recentOperations}
                labels={workLabels.recent}
                statusLabels={workLabels.status}
                locale={workLabels.locale}
              />
            </aside>
          </div>
        )}
      </div>

      <WorkFooter
        labels={workLabels.footer}
        onExceptions={() => setShowExceptions(true)}
        onPause={requestExit}
        onClose={() => void requestClose()}
        closeDisabled={closeRequestPending}
      />

      <div className="work-screen__overlays">
        {overlayState === "exit-pending" ? (
          <Alert tone="warn" style={{ position: "relative", zIndex: 1 }}>
            <p>{t("work.exitPending", { count: pendingSync })}</p>
            <Button size="floor" onClick={onExit}>
              {t("work.exitAnyway")}
            </Button>
            <Button size="floor" variant="secondary" onClick={() => setConfirmExit(false)}>
              {t("work.stay")}
            </Button>
          </Alert>
        ) : null}
        {overlayState === "clear-confirm" ? (
          <Alert tone="warn" title={t("box.confirmClearTitle")}>
            <p>{t("box.confirmClearDetail")}</p>
            <Button size="floor" onClick={confirmClearBox}>
              {t("box.confirmClear")}
            </Button>
            <Button size="floor" variant="secondary" onClick={() => setConfirmClear(false)}>
              {t("box.cancelClear")}
            </Button>
          </Alert>
        ) : null}
        {closeReasonPicker ? (
          <Alert tone="warn" title={t("work.closeReasonTitle")}>
            <p>{t("work.closeReasonDetail")}</p>
            <select value={closeReason} onChange={(event) => setCloseReason(event.target.value)}>
              <option value="production_defect">{t("work.closeReasons.production_defect")}</option>
              <option value="material_shortage">{t("work.closeReasons.material_shortage")}</option>
              <option value="equipment_stop">{t("work.closeReasons.equipment_stop")}</option>
              <option value="production_order_changed">
                {t("work.closeReasons.production_order_changed")}
              </option>
              <option value="planned_quantity_error">
                {t("work.closeReasons.planned_quantity_error")}
              </option>
              <option value="other_production_deviation">
                {t("work.closeReasons.other_production_deviation")}
              </option>
            </select>
            <Button
              size="floor"
              disabled={closeRequestPending}
              onClick={() => void performClose(closeReason)}
            >
              {t("work.closeReasonConfirm")}
            </Button>
            <Button size="floor" variant="secondary" onClick={() => setCloseReasonPicker(false)}>
              {t("work.stay")}
            </Button>
          </Alert>
        ) : null}
        {planReachedPrompt !== null ? (
          <Alert tone="ok" title={t("work.planReachedTitle")}>
            <p>{t("work.planReachedDetail", { count: planReachedPrompt })}</p>
            <Button
              size="floor"
              disabled={closeRequestPending}
              onClick={() => void confirmPlanClose()}
            >
              {t("work.closeShift")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              onClick={() => {
                planReachedPromptRef.current = false;
                planReachedAcknowledgedRef.current = true;
                setPlanReachedPrompt(null);
              }}
            >
              {t("work.continue")}
            </Button>
          </Alert>
        ) : null}
        {closeError ? (
          <Alert tone="error" title={t("work.closeFailed")}>
            <p>{closeError}</p>
            <Button size="floor" onClick={() => setCloseError(null)}>
              {t("work.stay")}
            </Button>
          </Alert>
        ) : null}
      </div>

      <FullScreenDialog
        open={blockingState === "serial-exhaustion"}
        title={t("box.noSerials")}
        backLabel={t("work.backToWork")}
        onClose={() => setNoSerials(false)}
      >
        <p style={{ color: "var(--fg-2)", font: "var(--floor-body)" }}>
          {t("box.noSerialsDetail")}
        </p>
      </FullScreenDialog>

      {signal ? (
        <SignalOverlay
          tone={signal.tone}
          title={signal.title}
          {...(signal.detail === undefined ? {} : { detail: signal.detail })}
        />
      ) : null}

      {printRecoveryHydrationFailed ? (
        <FullScreenDialog
          open
          title={t("box.printRecovery.restoreFailed")}
          backLabel={t("box.printRecovery.backToShifts")}
          onClose={onExit}
          initialFocus="dialog"
          footer={
            <Button
              size="floor"
              disabled={printRecoveryRetrying}
              onClick={retryPrintRecoveryHydration}
            >
              {t(
                printRecoveryRetrying
                  ? "box.printRecovery.pending"
                  : "box.printRecovery.retryRestore",
              )}
            </Button>
          }
        >
          <Alert tone="error" title={t("box.printRecovery.restoreFailedDetail")} />
        </FullScreenDialog>
      ) : null}

      {printRecovery ? (
        <BoxPrintRecovery
          sscc={printRecovery.sscc}
          errorCode={printRecovery.errorCode}
          pending={printRecovery.pending}
          onRetry={retryPrintRecovery}
          onSetup={() => onOpenPrinterSetup?.()}
          onSkip={skipPrintRecovery}
        />
      ) : null}

      {verification ? (
        <PrintVerification
          expected={verification.sscc}
          onVerified={handleVerified}
          onReprint={async () => {
            // A restart restores the durable box/SSCC but not volatile bytes.
            // Regenerate from that exact persisted identity; never close a
            // second box or allocate another serial. In-session verification
            // still sends the exact bytes already rendered. Both routes share
            // the physical-printer queue and expose only a fixed error category.
            try {
              if (verification.bytes && printing) {
                const reprintBytes = verification.bytes;
                await serializePrint(() => printing.print(printing.target, reprintBytes));
                return undefined;
              }
              const attempt = await attemptClosedBoxPrint(verification);
              if (attempt.kind === "failed") {
                console.error("station: box label reprint failed");
                return attempt.code;
              }
              return undefined;
            } catch {
              console.error("station: box label reprint failed");
              return "transport_failed";
            }
          }}
          onSkip={() => {
            const boxId = verification.boxId;
            if (!boxId) return Promise.resolve(false);
            return new Promise<boolean>((resolve) => {
              const accepted = queue.enqueueJob(async () => {
                try {
                  const won = await markPrintSkipped(exec, boxId, new Date().toISOString());
                  if (won) {
                    dequeueVerification();
                    void reloadClosedBoxes();
                  }
                  resolve(won);
                } catch {
                  console.error("station: recording print skip failed");
                  resolve(false);
                }
              });
              if (!accepted) resolve(false);
            });
          }}
          scanSource={source}
        />
      ) : null}
    </main>
  );
}
