import { readValidationRejectionReason } from "../lib/validation-reprocessing.js";
import type { readValidationProcessingState } from "../lib/validation-reprocessing.js";
import { ValidationProcessingStatus } from "../components/ValidationProcessingStatus.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  classifyScan,
  validateShiftScan,
  type LabelTemplateSpec,
  palletLabelFields,
  parseDuplicateKm,
  type ScanVerdict,
  type PrinterDpi,
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
  type BoxPrintErrorCode,
  type ClosedBoxSummary,
  type DeviceBox,
  type UnresolvedBoxPrint,
} from "../lib/boxes.js";
import { closeCurrentBox as closeCurrentBoxLib, type CloseBoxResult } from "../lib/close-box.js";
import {
  closeCurrentPallet as closeCurrentPalletLib,
  type ClosePalletResult,
} from "../lib/close-pallet.js";
import {
  currentPallet,
  disassemblePallet,
  findUnresolvedPalletPrint,
  listClosedPallets,
  markPalletPrintFailed,
  markPalletPrinted,
  markPalletPrintSkipped,
  markPalletPrintVerified,
  palletItemCount,
  reprintPallet,
  type ClosedPalletSummary,
} from "../lib/pallets.js";
import { PalletClose, type PalletPrintState } from "../components/PalletClose.js";
import { PalletExceptions } from "../components/PalletExceptions.js";
import { PalletStrip } from "../components/PalletStrip.js";
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
import { subscribeStationProductImageCache } from "../lib/product-image-cache.js";
import { rasterizeText } from "../lib/rasterizer.js";
import type { FloorWorkBarrier } from "../lib/credential-recovery.js";
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
import {
  useProductLabelWork,
  type ProductLabelWorkEnvironment,
} from "../lib/use-product-label-work.js";
import { ProductLabelInstrument } from "../ui/work/ProductLabelInstrument.js";
import { ProductLabelVerification } from "../ui/work/ProductLabelVerification.js";
import { ProductLabelHistory } from "../ui/exceptions/ProductLabelHistory.js";
import { ExceptionFlow } from "./ExceptionFlow.js";

export interface WorkScreenProps {
  exec: SqlExecutor;
  productLabelEnvironment?: ProductLabelWorkEnvironment;
  shiftId: string;
  terminalId: string | null;
  operatorId: string;
  expectedGtin14: string;
  productName: string;
  /** The catalog's short print name for the label's `product.printName` field; null = full name. */
  productPrintName?: string | null;
  productId?: string;
  productImage?: StationProductImageDescriptor | null | undefined;
  counterpartyName?: string | null;
  /** The shift's product egais code, printed on the box label's `product.egais` field. */
  productEgaisCode?: string | null;
  /** The shift's product shelf life in days, used to compute the box label's `expiry` field. */
  productShelfLifeDays?: number | null;
  /** Declared production date mirrored with the shift; null keeps the close-date fallback. */
  productionDate?: string | null;
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
  onFloorWorkRegister?: (barrier: FloorWorkBarrier) => () => void;
  /** Return to shift selection. Does NOT close the shift — that is a cabinet action. */
  onExit: () => void;
  /** Persists a local close and queues it for the server. */
  onCloseShift?: (reasonCode?: string | null) => Promise<OfflineShiftCloseSummary>;
  /** Scans still queued on this device, shown before the operator walks away. */
  pendingSync: number;
  /**
   * The station's window-mode control, surfaced inside the exception flow's
   * header so leaving fullscreen never requires abandoning a half-done
   * exception to reach the status bar's expanded controls.
   */
  exceptionWindowControl?: React.ReactNode;
  /**
   * This device's 9-digit GS1 issuer prefix for box SSCCs
   * (`StationBundle.sscc.issuerPrefix`), or null for a validation-mode
   * shift, or when the server could not resolve one for this device. Null
   * means the box UI does not render at all — there is nothing to close.
   */
  issuerPrefix: string | null;
  /** Items per box before it closes automatically (the shift's `boxCapacity`). */
  boxCapacity: number | null;
  /**
   * The shift's pallet capacity in boxes (`shift_mirror.palletBoxCapacity`),
   * or null/omitted on a shift with no pallets. Mirrors `boxCapacity`'s
   * null-means-off convention: there is no separate "pallets enabled" flag,
   * the same way `close-box.ts`'s `CloseBoxDeps` has none (see its own doc
   * comment) -- a non-null capacity is the one signal that turns the pallet
   * strip, early-close action and pallet exceptions on.
   */
  palletBoxCapacity?: number | null;
  /** Bumps after a freshly downloaded bundle replaces the offline mirror. */
  bundleRevision?: number;
  /**
   * Injectable for tests; defaults to the real `closeCurrentBox` (Task 12)
   * bound to this device's `issuerPrefix`.
   */
  closeCurrentBox?: (shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>;
  /**
   * Injectable for tests; defaults to the real `closeCurrentPallet` bound to
   * this device's `issuerPrefix`, used by the early-close overflow action.
   */
  closeCurrentPallet?: (shiftId: string, operatorId: string | null) => Promise<ClosePalletResult>;
  /** Fires for every raw payload the scan queue processes, whatever the verdict — test-only observability. */
  onScan?: (raw: string) => void;
  /** Opt-in per workstation: scan a closed box's printed label back before moving on. */
  verifyPrintedLabel: boolean;
  /** Where and how to render + send a box label. Omit to skip printing (e.g. no printer configured). */
  printing?: {
    target: PrintTarget;
    language: PrinterLanguage;
    /** The attached printer's resolution; null for settings saved before the field existed. */
    dpi?: PrinterDpi | null;
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
  productLabelEnvironment,
  shiftId,
  terminalId,
  operatorId,
  expectedGtin14,
  productName,
  productPrintName,
  productId,
  productImage,
  counterpartyName,
  productEgaisCode,
  productShelfLifeDays,
  productionDate,
  shiftNumber,
  plannedQty,
  source,
  sound,
  onScanRecorded,
  onScanQueueRegister,
  onFloorWorkRegister,
  onExit,
  onCloseShift,
  pendingSync,
  exceptionWindowControl,
  issuerPrefix,
  boxCapacity,
  palletBoxCapacity = null,
  bundleRevision = 0,
  closeCurrentBox: closeCurrentBoxProp,
  closeCurrentPallet: closeCurrentPalletProp,
  onScan,
  verifyPrintedLabel,
  printing,
  onOpenPrinterSetup,
  onPrintRecoveryChange,
}: WorkScreenProps) {
  const { t, i18n } = useTranslation();
  const productLabels = useProductLabelWork({
    exec,
    shiftId,
    terminalId,
    operatorId,
    ...(productLabelEnvironment ? { environment: productLabelEnvironment } : {}),
    ...(onFloorWorkRegister ? { register: onFloorWorkRegister } : {}),
  });
  const productLabelsRef = useRef(productLabels);
  productLabelsRef.current = productLabels;
  const productLabelsBlocked =
    productLabels.loading ||
    productLabels.error ||
    Boolean(productLabels.work && !productLabels.work.canAccept());

  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [processingState, setProcessingState] = useState<Awaited<
    ReturnType<typeof readValidationProcessingState>
  > | null>(null);
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
  // Driven by the cache itself rather than by a guess about how long media sync
  // takes. The bundle mirrors operational data first and syncs the product photo
  // separately, so this screen is routinely up and scanning before the photo
  // exists locally -- but far more often the photo was already cached from a
  // previous shift entry, and then there is nothing to re-read at all. Timers
  // got both cases wrong: they re-read twice for nothing in the common case,
  // and gave up before a slow sync landed in the case they existed for.
  useEffect(() => {
    if (!productId) return;
    return subscribeStationProductImageCache((changedProductId) => {
      if (changedProductId === productId) setImageRefreshKey((key) => key + 1);
    });
  }, [productId]);
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

  // Pallet aggregation (slice 06d) -- off entirely, the same way the box
  // section above is, whenever `palletBoxCapacity` is null or this device has
  // no `issuerPrefix` (a pallet always burns a serial from the SAME pool a
  // box does; see `close-box.ts`'s `CloseBoxDeps`).
  const [pallet, setPallet] = useState<{ palletId: string; boxCount: number } | null>(null);
  // Set when this device's serial pool could not close an over-capacity
  // pallet (`close-box.ts` leaves it open rather than blocking further
  // boxes). Text-only, per the project's accessibility rule -- `PalletStrip`
  // is the one place this surfaces, and it never blocks scanning.
  const [palletNoSerials, setPalletNoSerials] = useState(false);
  const [closedPallets, setClosedPallets] = useState<ClosedPalletSummary[]>([]);
  const [palletExceptionsOpen, setPalletExceptionsOpen] = useState(false);
  const [palletMenuOpen, setPalletMenuOpen] = useState(false);
  const [palletEarlyCloseConfirm, setPalletEarlyCloseConfirm] = useState(false);
  const [shiftClosePalletConfirm, setShiftClosePalletConfirm] = useState<{
    boxCount: number;
    /**
     * Set when the LAST attempt to close this pallet (from this very guard)
     * hit a dry serial pool. Without this, a second dry attempt re-shows
     * the identical prompt with no explanation of why confirming again did
     * nothing (Task 15 review, Finding 3) -- the strip's own
     * `pallet.noSerials` text is hidden behind this full-covering overlay.
     */
    blockedBySerials?: boolean;
  } | null>(null);
  // Communicates from `confirmShiftClosePallet`/`dismissPalletClose` back to
  // `performClose`: undefined means no shift-close is waiting on a pallet
  // resolution; otherwise it carries the reason code to retry with once the
  // operator has resolved the pallet's own label (or none was ever raised).
  const pendingShiftCloseReasonRef = useRef<string | null | undefined>(undefined);

  type PalletCloseScreenState = {
    palletId: string;
    sscc: string;
    boxCount: number;
    closedAt: string;
    print: PalletPrintState;
    errorCode: BoxPrintErrorCode | null;
    pending: boolean;
  };
  const [palletClose, setPalletCloseState] = useState<PalletCloseScreenState | null>(null);
  const palletCloseRef = useRef<PalletCloseScreenState | null>(null);
  const updatePalletClose = useCallback((next: PalletCloseScreenState | null): void => {
    palletCloseRef.current = next;
    setPalletCloseState(next);
  }, []);

  const reloadPallet = useCallback(async (): Promise<void> => {
    if (palletBoxCapacity === null || issuerPrefix === null) {
      setPallet(null);
      return;
    }
    try {
      const current = await currentPallet(exec, shiftId, terminalId);
      setPallet(current ? { palletId: current.palletId, boxCount: current.boxCount } : null);
    } catch (err) {
      console.error("station: failed to load the current pallet", err);
    }
  }, [exec, shiftId, terminalId, palletBoxCapacity, issuerPrefix]);

  const reloadClosedPallets = useCallback(async (): Promise<void> => {
    if (palletBoxCapacity === null || issuerPrefix === null) {
      setClosedPallets([]);
      return;
    }
    try {
      setClosedPallets(await listClosedPallets(exec, shiftId, terminalId));
    } catch (err) {
      console.error("station: failed to list closed pallets", err);
    }
  }, [exec, shiftId, terminalId, palletBoxCapacity, issuerPrefix]);

  useEffect(() => {
    void reloadPallet();
    void reloadClosedPallets();
  }, [reloadPallet, reloadClosedPallets]);

  // The pallet label's geometry, mirroring `labelSpecRef`/`labelSpecReady`
  // below for the box template: cleared first so a refreshed bundle that
  // removes the template never leaves a stale spec live, and resolved to a
  // no-op when this shift has no pallets so a stray future await never hangs.
  const palletLabelSpecRef = useRef<LabelTemplateSpec | null>(null);
  const palletLabelSpecReady = useRef<Promise<void> | null>(null);
  useEffect(() => {
    palletLabelSpecRef.current = null;
    if (palletBoxCapacity === null || issuerPrefix === null) {
      palletLabelSpecReady.current = Promise.resolve();
      return;
    }
    let cancelled = false;
    palletLabelSpecReady.current = readShiftMirror(exec, shiftId)
      .then((row) => {
        if (cancelled || !row?.palletLabelTemplateSpec) return;
        try {
          palletLabelSpecRef.current = JSON.parse(row.palletLabelTemplateSpec) as LabelTemplateSpec;
        } catch (err) {
          console.error("station: failed to parse the pallet label template spec", err);
        }
      })
      .catch((err: unknown) => {
        console.error("station: failed to read the shift mirror for the pallet label spec", err);
      });
    return () => {
      cancelled = true;
    };
  }, [exec, shiftId, palletBoxCapacity, issuerPrefix, bundleRevision]);

  function fieldsForClosedPallet(result: {
    sscc: string;
    boxCount: number;
    itemCount: number;
    closedAt: string;
  }): Record<string, string> {
    return palletLabelFields({
      sscc: result.sscc,
      boxCount: result.boxCount,
      itemCount: result.itemCount,
      productName,
      productPrintName: productPrintName ?? null,
      gtin14: expectedGtin14,
      egaisCode: productEgaisCode ?? null,
      shelfLifeDays: productShelfLifeDays ?? null,
      operatorName: null,
      counterpartyName: counterpartyName ?? null,
      closedAt: result.closedAt,
      productionDate: productionDate ?? null,
      shiftNumber: shiftNumber ?? null,
    });
  }

  /** The pallet-label equivalent of `attemptClosedBoxPrint` below, defined here
   * (rather than there) only because it needs `palletLabelSpecRef`/`Ready`,
   * declared alongside the rest of this pallet section. */
  async function attemptClosedPalletPrint(result: {
    sscc: string;
    boxCount: number;
    itemCount: number;
    closedAt: string;
  }) {
    await palletLabelSpecReady.current;
    const currentPrinting = printingRef.current;
    return attemptBoxPrint({
      template: palletLabelSpecRef.current,
      fields: fieldsForClosedPallet(result),
      printing: currentPrinting
        ? {
            ...currentPrinting,
            print: (target, bytes) => serializePrint(() => currentPrinting.print(target, bytes)),
          }
        : null,
      render: (template, fields, language, dpi) =>
        renderLabelBytes(template, fields, language, rasterizeText, { dpi }),
    });
  }

  /**
   * Attempts (or retries) printing the pallet label for `palletId`, and
   * records the durable outcome exactly the way `attemptRecoveryPrint` does
   * for a box: `markPalletPrintFailed`/`markPalletPrinted` before the
   * screen's `print` state ever changes, so a crash mid-attempt is
   * recovered from `findUnresolvedPalletPrint` on the next mount rather than
   * silently lost. Only updates `palletClose` when it still names THIS
   * pallet -- guards the same "a stale async result should not resurrect a
   * dismissed screen" hazard `updatePrintRecovery` callers already guard.
   */
  async function attemptPalletPrintNow(
    palletId: string,
    sscc: string,
    boxCount: number,
    closedAt: string,
  ): Promise<void> {
    let itemCount = 0;
    try {
      itemCount = await palletItemCount(exec, palletId);
    } catch (err) {
      console.error("station: failed to read the pallet's item count", err);
    }
    const attempt = await attemptClosedPalletPrint({ sscc, boxCount, itemCount, closedAt });

    if (attempt.kind === "failed") {
      try {
        await markPalletPrintFailed(exec, palletId, attempt.code);
      } catch {
        console.error("station: failed to persist pallet print category");
      }
      if (palletCloseRef.current?.palletId === palletId) {
        updatePalletClose({
          ...palletCloseRef.current,
          print: "failed",
          errorCode: attempt.code,
          pending: false,
        });
      }
      return;
    }

    try {
      await markPalletPrinted(exec, palletId);
    } catch {
      console.error("station: failed to persist printed pallet label");
      if (palletCloseRef.current?.palletId === palletId) {
        updatePalletClose({
          ...palletCloseRef.current,
          print: "failed",
          errorCode: "transport_failed",
          pending: false,
        });
      }
      return;
    }
    if (palletCloseRef.current?.palletId === palletId) {
      updatePalletClose({
        ...palletCloseRef.current,
        print: "printed",
        errorCode: null,
        pending: false,
      });
    }
    void reloadClosedPallets();
  }

  /**
   * Reacts to a `ClosePalletResult` from either an automatic close (a box
   * reaching pallet capacity, folded into `closeCurrentBox`) or the manual
   * early-close overflow action. `empty`/`already-closed` are silent no-ops,
   * mirroring how `performReservedClose` treats the box's own versions of
   * those statuses -- nothing this device did actually needs surfacing.
   * `no-serials` is the one rule the brief is explicit about: text-only, on
   * the strip, never a block -- boxes and scanning continue unaffected.
   */
  async function handlePalletCloseResult(result: ClosePalletResult): Promise<void> {
    if (result.status === "no-serials") {
      setPalletNoSerials(true);
      return;
    }
    if (result.status === "empty" || result.status === "already-closed") return;
    if (result.status === "invalid-serial") {
      console.error("station: pallet close produced an invalid serial");
      return;
    }
    setPalletNoSerials(false);
    updatePalletClose({
      palletId: result.palletId,
      sscc: result.sscc,
      boxCount: result.boxCount,
      closedAt: result.closedAt,
      print: "printing",
      errorCode: null,
      pending: false,
    });
    await attemptPalletPrintNow(result.palletId, result.sscc, result.boxCount, result.closedAt);
  }

  /** Every pallet-close resolution path (continue/confirm-printed/skip) funnels here. */
  function dismissPalletClose(): void {
    updatePalletClose(null);
    void reloadPallet();
    void reloadClosedPallets();
    const pendingReason = pendingShiftCloseReasonRef.current;
    if (pendingReason !== undefined) {
      pendingShiftCloseReasonRef.current = undefined;
      void performClose(pendingReason);
    }
  }

  function retryPalletPrint(): void {
    const cur = palletCloseRef.current;
    if (!cur || cur.pending) return;
    updatePalletClose({ ...cur, print: "printing", pending: true });
    void attemptPalletPrintNow(cur.palletId, cur.sscc, cur.boxCount, cur.closedAt).then(() => {
      // `attemptPalletPrintNow` already clears `pending` via the branch it
      // takes; this only guards the (unreachable in practice) case where
      // neither branch matched because the screen moved on in the meantime.
      if (palletCloseRef.current?.palletId === cur.palletId && palletCloseRef.current.pending) {
        updatePalletClose({ ...palletCloseRef.current, pending: false });
      }
    });
  }

  function skipPalletPrint(): void {
    const cur = palletCloseRef.current;
    if (!cur || cur.pending) return;
    updatePalletClose({ ...cur, pending: true });
    void (async () => {
      try {
        const won = await markPalletPrintSkipped(exec, cur.palletId, new Date().toISOString());
        if (won) dismissPalletClose();
        else updatePalletClose({ ...cur, pending: false });
      } catch {
        console.error("station: recording pallet print skip failed");
        updatePalletClose({ ...cur, pending: false });
      }
    })();
  }

  /** "unknown": the operator states the physical label already exists -- never reprints. */
  function confirmPalletPrinted(): void {
    const cur = palletCloseRef.current;
    if (!cur || cur.pending) return;
    updatePalletClose({ ...cur, pending: true });
    void (async () => {
      try {
        const won = await markPalletPrintVerified(exec, cur.palletId, new Date().toISOString());
        if (won) dismissPalletClose();
        else updatePalletClose({ ...cur, pending: false });
      } catch {
        console.error("station: recording pallet print verification failed");
        updatePalletClose({ ...cur, pending: false });
      }
    })();
  }

  function continuePalletClose(): void {
    if (palletCloseRef.current?.print === "printed") dismissPalletClose();
  }

  /** The "Ещё" overflow action: close the current pallet before it reaches capacity. */
  function enqueueManualPalletClose(): void {
    if (issuerPrefix === null || palletBoxCapacity === null) return;
    const capturedIssuerPrefix = issuerPrefix;
    const capturedPalletBoxCapacity = palletBoxCapacity;
    const impl =
      closeCurrentPalletProp ??
      ((sid: string, opId: string | null) =>
        closeCurrentPalletLib(
          {
            exec,
            issuerPrefix: capturedIssuerPrefix,
            palletBoxCapacity: capturedPalletBoxCapacity,
            terminalId,
          },
          sid,
          opId,
        ));
    if (
      !queue.enqueueJob(async () => {
        try {
          const result = await impl(shiftId, operatorId);
          await handlePalletCloseResult(result);
        } catch (err) {
          console.error("station: manual pallet close failed", err);
        }
      })
    ) {
      console.error("station: manual pallet close was not admitted");
    }
  }

  /** The shift-close flow's confirmed continuation: close the open pallet, then retry. */
  async function confirmShiftClosePallet(): Promise<void> {
    // Captured before clearing below -- if this attempt hits a dry serial
    // pool, the pallet is left exactly as it was (see `close-pallet.ts`),
    // so the re-shown prompt still names the same box count.
    const previousBoxCount = shiftClosePalletConfirm?.boxCount ?? 0;
    setShiftClosePalletConfirm(null);
    if (issuerPrefix === null || palletBoxCapacity === null) {
      pendingShiftCloseReasonRef.current = undefined;
      return;
    }
    const capturedIssuerPrefix = issuerPrefix;
    const capturedPalletBoxCapacity = palletBoxCapacity;
    // Resolved with the actual close attempt's outcome (rather than written
    // to an outer local from inside the queued job) so there is nothing for
    // `performClose` below to read except what THIS attempt produced.
    const lastResult = await new Promise<ClosePalletResult | null>((resolve) => {
      const accepted = queue.enqueueJob(async () => {
        let result: ClosePalletResult | null = null;
        try {
          const impl =
            closeCurrentPalletProp ??
            ((sid: string, opId: string | null) =>
              closeCurrentPalletLib(
                {
                  exec,
                  issuerPrefix: capturedIssuerPrefix,
                  palletBoxCapacity: capturedPalletBoxCapacity,
                  terminalId,
                },
                sid,
                opId,
              ));
          result = await impl(shiftId, operatorId);
          await handlePalletCloseResult(result);
        } catch (err) {
          console.error("station: pallet close before shift close failed", err);
        } finally {
          resolve(result);
        }
      });
      if (!accepted) resolve(null);
    });
    // No print screen was raised (empty/already-closed/invalid-serial/
    // no-serials) -- `dismissPalletClose` will never fire for this pallet,
    // so nothing else continues the shift close unless this does it now.
    if (palletCloseRef.current === null) {
      // A dry serial pool leaves the pallet open exactly as it was:
      // `performClose` would just find the SAME open pallet and silently
      // re-show this identical confirmation, leaving the operator to press
      // a button that does nothing with no explanation (Task 15 review,
      // Finding 3). Surface the reason instead, and keep the pending
      // shift-close reason around for whenever this device's pool refills.
      if (lastResult?.status === "no-serials") {
        setShiftClosePalletConfirm({ boxCount: previousBoxCount, blockedBySerials: true });
        return;
      }
      const reason = pendingShiftCloseReasonRef.current;
      pendingShiftCloseReasonRef.current = undefined;
      await performClose(reason);
    }
  }

  function handlePalletReprint(palletId: string, reason: string): Promise<void> {
    const target = closedPallets.find((candidate) => candidate.palletId === palletId);
    if (!target) return Promise.reject(new Error("closed pallet is no longer available"));
    return enqueueExceptionJob(async () => {
      await reprintPallet(exec, {
        palletId,
        shiftId,
        terminalId,
        operatorId,
        reason,
        occurredAt: new Date().toISOString(),
      });
      // `target.closedAt` is the pallet's persisted closure timestamp, so a
      // reprint reproduces the ORIGINAL label's dates, mirroring
      // `handleReprint`'s own reasoning for a box.
      const itemCount = await palletItemCount(exec, palletId).catch(() => 0);
      await attemptClosedPalletPrint({
        sscc: target.sscc,
        boxCount: target.boxCount,
        itemCount,
        closedAt: target.closedAt,
      });
      await reloadClosedPallets();
      live.current.onScanRecorded?.();
    });
  }

  function handlePalletDisassemble(palletId: string, reason: string): Promise<void> {
    const target = closedPallets.find((candidate) => candidate.palletId === palletId);
    if (!target) return Promise.reject(new Error("closed pallet is no longer available"));
    return enqueueExceptionJob(async () => {
      await disassemblePallet(exec, {
        palletId,
        shiftId,
        terminalId,
        operatorId,
        reason,
        occurredAt: new Date().toISOString(),
      });
      await reloadClosedPallets();
      live.current.onScanRecorded?.();
    });
  }

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
      /** The box's persisted `closed_at`. The "reprint" action below can
       * re-render the label from scratch when the original bytes are gone
       * (a restart), and must reproduce the SAME dates the first label
       * carried -- see `fieldsForClosedBox`. */
      closedAt: string;
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
    closedAt: string;
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
    productLabelsBlocked ||
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
    noSerials ||
    palletClose ||
    palletExceptionsOpen ||
    palletMenuOpen ||
    palletEarlyCloseConfirm ||
    shiftClosePalletConfirm,
  );

  async function pauseProductLabels() {
    ordinaryScanBlockedRef.current = true;
    queue.discardBufferedScans();
    const closing = queue.close();
    await productLabelsRef.current.work?.close();
    await closing;
    onExit();
  }
  function requestExit() {
    if (
      productLabelsRef.current.work ||
      productLabelsRef.current.loading ||
      productLabelsRef.current.error
    ) {
      void pauseProductLabels();
      return;
    }
    if (ordinaryScanBlockedRef.current) return;
    if (pendingSync > 0) setConfirmExit(true);
    else onExit();
  }

  async function performClose(reasonCode?: string | null): Promise<void> {
    if (!onCloseShift || closeRequestRef.current) return;
    // A pallet still open with boxes on it must be closed (and its label
    // resolved) before the shift itself does -- otherwise those boxes'
    // pallet membership is never printed or reported. Checked BEFORE any of
    // `closeRequestPending`/`onCloseShift` below, so confirming this prompt
    // is the only thing that can start the actual shift-close request.
    if (palletBoxCapacity !== null && issuerPrefix !== null) {
      let openPallet: { boxCount: number } | null = null;
      try {
        openPallet = await currentPallet(exec, shiftId, terminalId);
      } catch (err) {
        console.error("station: failed to check for an open pallet before closing the shift", err);
      }
      if (openPallet && openPallet.boxCount > 0) {
        pendingShiftCloseReasonRef.current = reasonCode ?? null;
        setShiftClosePalletConfirm({ boxCount: openPallet.boxCount });
        return;
      }
    }
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
      else if (message.includes("PRODUCT_LABEL_"))
        setCloseError(
          t(
            message.includes("CLOSE_CHANGED")
              ? "productLabels.closeChanged"
              : "productLabels.closeBlocked",
          ),
        );
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
            closedAt: unresolved.closedAt,
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

  // Restores an unresolved pallet print left over from a restart -- the
  // pallet equivalent of the box print-recovery hydration above. A `pending`
  // row with a recorded error category becomes `failed` (retryable); one
  // with none becomes `unknown` (an interruption mid-print this device
  // cannot resolve on its own) -- and per the brief's rule, `unknown` NEVER
  // triggers another print by itself. Unlike boxes, a pallet has no
  // scan-back verification path, so `findUnresolvedPalletPrint` only ever
  // returns a still-`pending` row -- there is no `printed` case to branch on
  // here (Task 15 review, Finding 5).
  useEffect(() => {
    if (palletBoxCapacity === null || issuerPrefix === null) return;
    let cancelled = false;
    void findUnresolvedPalletPrint(exec, shiftId, terminalId)
      .then((unresolved) => {
        if (cancelled || !unresolved) return;
        updatePalletClose({
          palletId: unresolved.palletId,
          sscc: unresolved.sscc,
          boxCount: unresolved.boxCount,
          closedAt: unresolved.closedAt,
          print: unresolved.errorCode !== null ? "failed" : "unknown",
          errorCode: unresolved.errorCode,
          pending: false,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) console.error("station: failed to restore pallet print recovery", err);
      });
    return () => {
      cancelled = true;
    };
  }, [exec, shiftId, terminalId, palletBoxCapacity, issuerPrefix, updatePalletClose]);

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

  /**
   * `closedAt` comes from the BOX, never from `new Date()` at render time.
   * When the shift has no declared production date, the label falls back to
   * that close date and derives expiry from the same day. Stamping the
   * current clock here made a recovery print issued the next morning — or a
   * reprint days later — carry a different expiry than the label already
   * stuck to the same physical box. Every caller supplies the box's own
   * persisted `closed_at`: the close result for a fresh print, `boxes_mirror`
   * (via `findUnresolvedBoxPrint` / `listClosedBoxes`) for every later one.
   *
   * The timestamp stays a UTC ISO instant in storage; `boxLabelFields`
   * renders it as this station's LOCAL calendar day (storage UTC, display
   * local), so the legacy fallback for a box closed at 01:00 Moscow time
   * prints today, not yesterday. A valid declared date wins unchanged.
   */
  function fieldsForClosedBox(result: {
    sscc: string;
    itemCount: number;
    closedAt: string;
  }): Record<string, string> {
    return boxLabelFields({
      sscc: result.sscc,
      itemCount: result.itemCount,
      productName,
      productPrintName: productPrintName ?? null,
      gtin14: expectedGtin14,
      egaisCode: productEgaisCode ?? null,
      shelfLifeDays: productShelfLifeDays ?? null,
      operatorName: null,
      counterpartyName: counterpartyName ?? null,
      closedAt: result.closedAt,
      productionDate: productionDate ?? null,
      shiftNumber: shiftNumber ?? null,
    });
  }

  async function attemptClosedBoxPrint(result: {
    sscc: string;
    itemCount: number;
    closedAt: string;
  }) {
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
      render: (template, fields, language, dpi) =>
        renderLabelBytes(template, fields, language, rasterizeText, { dpi }),
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
        closedAt: job.closedAt,
        bytes: attempt.bytes,
        boxId: job.boxId,
      });
    }
    void reloadClosedBoxes();
  }

  async function printExceptionLabel(
    result: { sscc: string; itemCount: number; closedAt: string },
    boxId: string,
  ): Promise<void> {
    const attempt = await attemptClosedBoxPrint(result);
    if (attempt.kind === "printed" && verifyPrintedLabel) {
      enqueueVerification({
        sscc: result.sscc,
        itemCount: result.itemCount,
        closedAt: result.closedAt,
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
          closeCurrentBoxLib(
            // A non-null `palletBoxCapacity` is what actually turns pallets
            // on (see `CloseBoxDeps`'s own doc comment) -- this is the one
            // call site that makes a shift build pallets at all.
            { exec, issuerPrefix: reservedIssuerPrefix, palletBoxCapacity, terminalId },
            sid,
            operatorId,
          ));

      let result: CloseBoxResult;
      try {
        result = await impl(shiftId, operatorId);
      } catch (err) {
        console.error("station: closeCurrentBox failed", err);
        return;
      }

      if (result.status === "empty") return;
      // `already-closed`: a concurrent close already won the race for this
      // exact box (see `CloseBoxResult`'s own doc comment in
      // `close-box.ts`). By the time this call's guarded UPDATE ran, there
      // was nothing left here for this device to do -- the winning close
      // already owns whatever printing/recovery follows, so this mirrors
      // `empty`'s silent no-op rather than surfacing an operator-facing
      // error for something this device did not actually cause.
      if (result.status === "already-closed") return;
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
      void reloadPallet();
      await attemptRecoveryPrint({
        boxId: closingBoxId,
        sscc: result.sscc,
        itemCount: result.itemCount,
        closedAt: result.closedAt,
        state: "pending",
        errorCode: "transport_failed",
        pending: false,
      });
      // This box brought its pallet to capacity (or tried to): print the
      // pallet's own label. Independent of whether the BOX's own label just
      // printed cleanly -- a pallet close is never skipped because its last
      // box's label had trouble, and vice versa.
      if (result.pallet) await handlePalletCloseResult(result.pallet);
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
          !productLabelsRef.current.loading &&
          !productLabelsRef.current.error &&
          (!productLabelsRef.current.work || productLabelsRef.current.work.canAccept()) &&
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
          let verdict = validateShiftScan(raw, {
            expectedGtin14,
            isDuplicate: (key) => !productLabelsRef.current.work && keys.current.has(key),
          });
          let duplicateFirstSeen: string | null | undefined;
          if (verdict.status === "duplicate") {
            duplicateFirstSeen = await findFirstSeen(exec, verdict.key);
            if (duplicateFirstSeen === null) {
              // Periodic sync removed a server-released code after this
              // screen loaded its in-memory index. Confirm only the apparent
              // duplicate against SQLite, then heal the stale Set in place.
              keys.current.delete(verdict.key);
              verdict = validateShiftScan(raw, {
                expectedGtin14,
                isDuplicate: (key) => !productLabelsRef.current.work && keys.current.has(key),
              });
            }
          }
          if (verdict.status === "ok" && productLabelsRef.current.work) {
            try {
              parseDuplicateKm(raw);
            } catch {
              verdict = { status: "invalid", raw };
            }
          }
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
            const labelWork = productLabelsRef.current.work;
            if (labelWork && codeHash) {
              // No physical input buffered before the print may confirm the new label.
              queue.discardBufferedScans();
              const result = await labelWork.accept(raw);
              if (result.status === "busy") throw new Error("PRODUCT_LABEL_BUSY");
              keys.current.add(codeHash);
              if (result.status === "duplicate")
                return {
                  raw,
                  verdict: { status: "duplicate", key: codeHash },
                  firstSeen: await findFirstSeen(exec, codeHash),
                  duplicateReason: await readValidationRejectionReason(exec, shiftId, codeHash),
                };
              const plannedQty = live.current.plannedQty;
              const planReached =
                plannedQty !== null &&
                plannedQty !== undefined &&
                !planReachedAcknowledgedRef.current &&
                (
                  await exec.all<{ actualQty: number }>(
                    "SELECT COUNT(*) AS actualQty FROM station_processed_codes WHERE shift_id = ?",
                    [shiftId],
                  )
                )[0]?.actualQty === plannedQty;
              if (planReached) planReachedPromptRef.current = true;
              return {
                raw,
                verdict,
                firstSeen: null,
                productLabel: true,
                ...(planReached ? { planReached } : {}),
              };
            }
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
                  "SELECT COUNT(*) AS actualQty FROM station_processed_codes WHERE shift_id = ?",
                  [shiftId],
                )
              )[0]?.actualQty === plannedQty;
            if (planReached) planReachedPromptRef.current = true;
            return { raw, verdict, firstSeen: null, ...(planReached ? { planReached } : {}) };
          }

          await recordScan(exec, event, null);
          const firstSeen =
            verdict.status === "duplicate"
              ? (duplicateFirstSeen ?? (await findFirstSeen(exec, verdict.key)))
              : null;
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
                ? outcome.duplicateReason
                  ? liveT(`productLabels.refusal.${outcome.duplicateReason}`)
                  : liveT("signal.duplicate")
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

          if (outcome.productLabel) playSignalTone("ok", live.current.sound);
          else publishVerdict(outcome.verdict, title, detail);

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
      // `target.closedAt` is the box's persisted closure timestamp, so a
      // reprint reproduces the ORIGINAL label's dates rather than today's.
      void printExceptionLabel(
        { sscc: target.sscc, itemCount: target.itemCount, closedAt: target.closedAt },
        boxId,
      );
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
    if (showExceptions && productLabelsRef.current.work) return source.start(() => {});
    if (
      verification ||
      confirmClear ||
      boxActionPending ||
      showExceptions ||
      palletExceptionsOpen ||
      palletMenuOpen ||
      palletEarlyCloseConfirm ||
      shiftClosePalletConfirm
    ) {
      return;
    }
    // Keep the physical source subscribed while serial recovery -- or the
    // pallet close/print screen -- owns the screen, but deliberately discard
    // its payloads. A keyboard-wedge source must still preventDefault() on
    // its terminating Enter; unsubscribing it would let that Enter activate
    // the dialog's focused button and dismiss a blocking state without an
    // intentional operator action.
    if (printRecovery || noSerials || palletClose) return source.start(() => {});
    let sourceActive = true;
    const stop = source.start((raw) => {
      if (!sourceActive) return;
      const labels = productLabelsRef.current;
      if (labels.loading || labels.error) return;
      if (labels.work && !labels.work.canAccept()) {
        const state = labels.work.getSnapshot();
        if (state.busy || !state.ready || state.error) return;
        void labels.work.verify(raw).then((result) => {
          if (result !== "stale") {
            live.current.onScanRecorded?.();
            playSignalTone(result === "match" ? "ok" : "error", live.current.sound);
          }
        });
        return;
      }
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
    return () => {
      sourceActive = false;
      stop();
    };
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
    palletClose,
    palletExceptionsOpen,
    palletMenuOpen,
    palletEarlyCloseConfirm,
    shiftClosePalletConfirm,
  ]);

  const printBlocked =
    productLabelsBlocked ||
    (issuerPrefix !== null &&
      (!printRecoveryHydrated ||
        printAdmissionBlocked ||
        printRecovery !== null ||
        verification !== null));
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
        {palletExceptionsOpen ? (
          <PalletExceptions
            pallets={closedPallets}
            onReprint={handlePalletReprint}
            onDisassemble={handlePalletDisassemble}
            onBack={() => setPalletExceptionsOpen(false)}
            onPendingChange={setBoxActionPending}
          />
        ) : showExceptions && productLabels.work ? (
          <ProductLabelHistory work={productLabels.work} onBack={() => setShowExceptions(false)} />
        ) : showExceptions ? (
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
            scanSource={source}
            windowControl={exceptionWindowControl}
            {...(palletBoxCapacity !== null
              ? {
                  onPalletExceptions: () => {
                    setShowExceptions(false);
                    setPalletExceptionsOpen(true);
                  },
                }
              : {})}
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
                gtin={expectedGtin14}
                refreshKey={imageRefreshKey}
                showVerdict={issuerPrefix === null && !productLabels.work}
              />
              {productLabels.work ? (
                <>
                  <ValidationProcessingStatus
                    exec={exec}
                    shiftId={shiftId}
                    refreshKey={accepted + rejected}
                    onState={setProcessingState}
                  />
                  <ProductLabelInstrument
                    job={productLabels.state.job}
                    busy={productLabels.state.busy}
                    verification={productLabels.verification}
                  />
                </>
              ) : null}
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
                  lastAccepted={
                    latestAcceptedOperation?.identity
                      ? { serial: latestAcceptedOperation.identity.serial }
                      : null
                  }
                  verdictLabels={{
                    ok: workLabels.status.ok,
                    waiting: workLabels.status.waiting,
                  }}
                  onClose={enqueueManualClose}
                  onUndo={() => void handleUndo()}
                  onClear={() => setConfirmClear(true)}
                />
              ) : null}
              {palletBoxCapacity !== null && issuerPrefix !== null ? (
                <PalletStrip
                  boxCount={pallet?.boxCount ?? 0}
                  capacity={palletBoxCapacity}
                  serials={palletNoSerials ? "empty" : "available"}
                />
              ) : null}
            </div>
            <aside className="work-screen__secondary" aria-label={workLabels.summary}>
              <WorkCounters
                accepted={productLabels.work ? (processingState?.processed ?? 0) : accepted}
                rejected={rejected}
                pendingSync={Math.max(
                  pendingSync,
                  productLabels.work ? (processingState?.pending ?? 0) : 0,
                )}
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
        closeDisabled={closeRequestPending || productLabelsBlocked}
        {...(palletBoxCapacity !== null && issuerPrefix !== null
          ? { onMore: () => setPalletMenuOpen(true) }
          : {})}
      />

      {productLabels.work && productLabelsBlocked && !showExceptions ? (
        <ProductLabelVerification
          state={productLabels.state}
          work={productLabels.work}
          onPause={() => void pauseProductLabels()}
          {...(onOpenPrinterSetup ? { onSetup: onOpenPrinterSetup } : {})}
        />
      ) : null}
      {productLabels.error ? (
        <FullScreenDialog
          open
          title={t("productLabels.storageError")}
          backLabel={t("productLabels.pause")}
          onClose={() => void pauseProductLabels()}
        >
          <Alert tone="error" title={t("productLabels.storageError")} />
        </FullScreenDialog>
      ) : null}

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
        {palletMenuOpen ? (
          <Alert tone="info" title={t("work.more")} style={{ position: "relative", zIndex: 1 }}>
            <Button
              size="floor"
              onClick={() => {
                setPalletMenuOpen(false);
                setPalletEarlyCloseConfirm(true);
              }}
            >
              {t("pallet.earlyClose")}
            </Button>
            <Button size="floor" variant="secondary" onClick={() => setPalletMenuOpen(false)}>
              {t("work.stay")}
            </Button>
          </Alert>
        ) : null}
        {palletEarlyCloseConfirm ? (
          <Alert
            tone="warn"
            title={t("pallet.earlyClose")}
            style={{ position: "relative", zIndex: 1 }}
          >
            <p>
              {t("pallet.earlyCloseDetail", {
                count: pallet?.boxCount ?? 0,
                capacity: palletBoxCapacity ?? 0,
              })}
            </p>
            <Button
              size="floor"
              onClick={() => {
                setPalletEarlyCloseConfirm(false);
                enqueueManualPalletClose();
              }}
            >
              {t("box.confirmAction")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              onClick={() => setPalletEarlyCloseConfirm(false)}
            >
              {t("work.stay")}
            </Button>
          </Alert>
        ) : null}
        {shiftClosePalletConfirm ? (
          <Alert
            tone="warn"
            title={t("work.closeShift")}
            style={{ position: "relative", zIndex: 1 }}
          >
            <p>
              {t("work.palletOpenAtClose", {
                count: shiftClosePalletConfirm.boxCount,
                capacity: palletBoxCapacity ?? 0,
              })}
            </p>
            {shiftClosePalletConfirm.blockedBySerials ? (
              <p role="alert">{t("work.palletOpenAtCloseNoSerials")}</p>
            ) : null}
            <Button size="floor" onClick={() => void confirmShiftClosePallet()}>
              {t("work.palletOpenAtCloseConfirm")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              onClick={() => {
                pendingShiftCloseReasonRef.current = undefined;
                setShiftClosePalletConfirm(null);
              }}
            >
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

      {palletClose ? (
        <PalletClose
          result={{ status: "closed", sscc: palletClose.sscc, boxCount: palletClose.boxCount }}
          print={palletClose.print}
          errorCode={palletClose.errorCode}
          pending={palletClose.pending}
          onRetry={retryPalletPrint}
          onSetup={() => onOpenPrinterSetup?.()}
          onSkip={skipPalletPrint}
          onConfirmPrinted={confirmPalletPrinted}
          onReprint={retryPalletPrint}
          onContinue={continuePalletClose}
        />
      ) : null}
    </main>
  );
}
