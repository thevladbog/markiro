import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import { parseScannedSscc, type StationInventoryBundleManifest } from "@markiro/domain";

import {
  listRecentInventoryOperations,
  readInventoryProgress,
  reconcilePendingInventoryEvents,
  recordInventoryScan,
  type InventoryProgress,
  type InventoryScanDateMismatch,
  type RecentInventoryOperation,
  type RecordInventoryScanResult,
} from "../lib/inventory-journal.js";
import { formatCivilDate } from "../lib/civil-date-format.js";
import { loadInventoryProductionDate, setInventoryProductionDate } from "../lib/inventory-date.js";
import {
  attemptInventoryBoxPrint,
  listInventoryBoxPrintAttempts,
  processNextInventoryRemoteReprint,
  readInventoryBoxPrintFacts,
  readUnresolvedInventoryReprint,
  recoverInterruptedInventoryPrint,
  searchInventoryPrintedBoxesBySscc,
  InventoryPrintRecoveryStaleError,
  type InventoryBoxPrintFacts,
  type InventoryPrintedBoxMatch,
  type InventoryBoxPrintingTransport,
  type InventoryBoxPrintResult,
  type InventoryPrintErrorCode,
  type UnresolvedInventoryReprint,
} from "../lib/inventory-box-printing.js";
import type { StationClient } from "../lib/api-client.js";
import type { CredentialGeneration } from "../lib/credential-recovery.js";
import { leaveInventoryTask } from "../lib/inventory-sync.js";
import {
  clearOpenInventoryRepackBox,
  changeOpenInventoryRepackDate,
  readInventoryRepackState,
  recordInventoryRepackScan,
  removeLastInventoryRepackItem,
  resolveInvalidatedInventoryRepackBox,
  type InventoryRepackScanResult,
  type InventoryRepackStateView,
} from "../lib/inventory-repacking.js";
import type { SqlExecutor } from "../lib/mirror.js";
import { createScanQueue, type ScanQueue } from "../lib/scan-queue.js";
import type { ScanSource } from "../lib/scan-source.js";
import { useInventorySyncEngine } from "../lib/use-inventory-sync-engine.js";
import { InventoryProgress as InventoryProgressView } from "../ui/inventory/InventoryProgress.js";
import { InventoryBoxPrintRecovery } from "../ui/inventory/InventoryBoxPrintRecovery.js";
import { InventoryScanInstrument } from "../ui/inventory/InventoryScanInstrument.js";
import { RepackBoxInstrument } from "../ui/inventory/RepackBoxInstrument.js";
import { RepackCorrections, REPACK_REPRINT_MIN_QUERY } from "../ui/inventory/RepackCorrections.js";
import { StationScreen } from "../ui/StationScreen.js";

export interface InventoryWorkScreenProps {
  exec: SqlExecutor;
  inventory: StationInventoryBundleManifest;
  deviceId: string;
  operatorId: string;
  source: ScanSource;
  client?: Pick<StationClient, "get" | "post">;
  credentialGeneration?: CredentialGeneration;
  floorTaskPointerValue?: string;
  onLeft?: () => void;
  onScanQueueRegister?: (queue: ScanQueue) => () => void;
  printing?: InventoryBoxPrintingTransport | null;
  onOpenPrinterSetup?: () => void;
  onPrintRecoveryChange?: (blocked: boolean) => void;
  createEventId?: () => string;
  now?: () => string;
  /** Development-only frozen input for driving the production render branches. */
  galleryState?: InventoryWorkGalleryState;
}

export type InventoryWorkGalleryState =
  | {
      mode: "check";
      productionDate: string;
      pendingSync: number;
      progress: InventoryProgress;
      recent: RecentInventoryOperation[];
      result: RecordInventoryScanResult | null;
      writeFailed?: boolean;
      leaveFailed?: boolean;
      dateDialog?: boolean;
      heldScan?: HeldInventoryScan | null;
    }
  | {
      mode: "repack";
      productionDate: string;
      pendingSync: number;
      state: InventoryRepackStateView;
      recent: RecentInventoryOperation[];
      result: InventoryRepackScanResult | null;
      writeFailed?: boolean;
      leaveFailed?: boolean;
      dateDialog?: boolean;
      correctionsDialog?: boolean;
      printDisplay?: InventoryPrintDisplay | null;
      reprintSscc?: string;
      reprintMatches?: {
        boxId: string;
        sscc: string;
        quantity: number;
        productionDate: string;
      }[];
      heldScan?: HeldRepackScan | null;
    };

const EMPTY_PROGRESS: InventoryProgress = {
  verified: 0,
  discrepancies: 0,
  protected: 0,
  claimedByDevice: 0,
  acceptedBoxes: 0,
  acceptedItems: 0,
};

type HeldInventoryScan = InventoryScanDateMismatch & { raw: string };

type CheckScanOutcome = ({ outcome: "recorded" } & RecordInventoryScanResult) | HeldInventoryScan;

const defaultEventId = () => crypto.randomUUID();
const defaultNow = () => new Date().toISOString();

function printErrorCode(value: string | null | undefined): InventoryPrintErrorCode | null {
  switch (value) {
    case "template_missing":
    case "printer_unconfigured":
    case "render_failed":
    case "transport_failed":
    case "persistence_failed":
      return value;
    default:
      return null;
  }
}

export interface InventoryPrintDisplay extends InventoryBoxPrintFacts {
  attemptId: string | null;
  attemptNumber: number;
  attemptState: "printing" | "failed" | null;
  kind: "initial" | "reprint";
  state: "printing" | "printed" | "failed";
  errorCode: InventoryPrintErrorCode | null;
}

function restoredResult(operation: RecentInventoryOperation): RecordInventoryScanResult {
  return {
    verdict: operation.verdict,
    claimedCount: operation.claimedCount,
    boxChildCount: operation.scanKind === "known_box" ? operation.claimedCount : 0,
    firstWinning: operation.firstWinning,
    scanKind: operation.scanKind,
    serialSuffix: operation.serialSuffix,
    ssccSuffix: operation.ssccSuffix,
  };
}

/**
 * Runs `fn` as a queued job behind any already-buffered scans/jobs, in the
 * same strict order the scan queue processes everything else. Resolves once
 * `fn` completes; rejects if the queue is closed or `fn` throws.
 */
function runQueuedJob(queue: ScanQueue, fn: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const accepted = queue.enqueueJob(async () => {
      try {
        await fn();
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("inventory scan queue job failed"));
        throw error;
      }
    });
    if (!accepted) reject(new Error("inventory scan queue is closed"));
  });
}

export function InventoryWorkScreen(props: InventoryWorkScreenProps) {
  return props.inventory.mode === "repack" ? (
    <RepackInventoryWorkScreen {...props} inventory={{ ...props.inventory, mode: "repack" }} />
  ) : (
    <CheckInventoryWorkScreen {...props} inventory={{ ...props.inventory, mode: "check" }} />
  );
}

function CheckInventoryWorkScreen({
  exec,
  inventory,
  deviceId,
  operatorId,
  source,
  client,
  credentialGeneration,
  floorTaskPointerValue,
  onLeft,
  onScanQueueRegister,
  createEventId = defaultEventId,
  now = defaultNow,
  galleryState,
}: InventoryWorkScreenProps & {
  inventory: StationInventoryBundleManifest & { mode: "check" };
}) {
  const { t, i18n } = useTranslation();
  const gallery = galleryState?.mode === "check" ? galleryState : null;
  const [productionDate, setProductionDate] = useState<string | null>(
    gallery?.productionDate ?? null,
  );
  const [dateDraft, setDateDraft] = useState(
    gallery?.productionDate ?? inventory.productionDateFrom,
  );
  const [dateDialog, setDateDialog] = useState(gallery?.dateDialog ?? false);
  // Read synchronously (not via effect) so refresh()'s active-date reload
  // below always sees the dialog state as of the render that is current when
  // its promise resolves, not one render behind (mirrors the repack screen's
  // `old-box-selected` reload).
  const dateDialogOpenRef = useRef(dateDialog);
  dateDialogOpenRef.current = dateDialog;
  const [progress, setProgress] = useState<InventoryProgress>(gallery?.progress ?? EMPTY_PROGRESS);
  const [recent, setRecent] = useState<RecentInventoryOperation[]>(gallery?.recent ?? []);
  const [result, setResult] = useState<RecordInventoryScanResult | null>(gallery?.result ?? null);
  const [writeFailed, setWriteFailed] = useState(gallery?.writeFailed ?? false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(gallery?.leaveFailed ?? false);
  const mounted = useRef(true);
  const [heldScan, setHeldScan] = useState<HeldInventoryScan | null>(gallery?.heldScan ?? null);
  const heldRef = useRef(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const dialogBusyRef = useRef(false);
  const bypassRef = useRef<string | null>(null);
  const queueRef = useRef<ScanQueue | null>(null);
  // Bumped by every local, authoritative date write (applyDate, adoptHeldDate)
  // right when its state lands. refresh()'s active-date read below can start
  // before such a write is even queued and resolve after that write's own
  // setProductionDate call — a fired-and-forget refresh from one scan's
  // onOutcome racing a date change queued right behind it in the same scan
  // queue. Comparing versions lets refresh() detect "a fresher local write
  // happened while I was reading" and drop its now-stale result instead of
  // clobbering the newer state.
  const dateWriteVersionRef = useRef(0);
  // Bumped at the start of every refresh() call. `refresh()` is fire-and-
  // forget from a scan's onOutcome/onError and is also invoked by the sync
  // engine's onProgressApplied and its own mount/heartbeat pollProgress —
  // none of those call sites are serialized against each other, and (unlike
  // the test harness's strictly FIFO SQLite wrapper) the real tauriExecutor
  // is genuinely concurrent IPC, so an older-started refresh's read can
  // resolve after a newer one's. Comparing the sequence number lets a
  // refresh detect "a fresher refresh has since started" and drop its own
  // now-stale results (progress, recent, and date alike) instead of
  // reverting the screen to an earlier state.
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = (refreshSeqRef.current += 1);
    const dateVersionAtStart = dateWriteVersionRef.current;
    const [nextProgress, nextRecent, activeDate] = await Promise.all([
      readInventoryProgress(exec, inventory.inventoryId, inventory.snapshotId, deviceId),
      listRecentInventoryOperations(exec, inventory.inventoryId, inventory.snapshotId),
      // The journal's guardSourceProductionDate can silently move the
      // terminal's active date on a scan's first-ever code (see
      // inventory-journal.ts), with no dialog and no other signal to this
      // screen. refresh() is the one path every scan outcome and every sync
      // pull already goes through, so re-reading the persisted date here
      // keeps the toolbar (and the date dialog's draft) self-healing instead
      // of relying on a special case tied to a particular scan verdict.
      loadInventoryProductionDate(exec, {
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
      }),
    ]);
    if (!mounted.current || refreshSeqRef.current !== seq) return;
    setProgress(nextProgress);
    setRecent(nextRecent);
    setResult((current) => current ?? (nextRecent[0] ? restoredResult(nextRecent[0]) : null));
    if (activeDate !== null && dateWriteVersionRef.current === dateVersionAtStart) {
      // Never *establish* productionDate here, only update it: queue.open()
      // and the source.start effect both gate scanner intake on
      // `productionDate !== null`, and that gate is deliberately owned by
      // the hydration effect, which only sets it after
      // reconcilePendingInventoryEvents has run. A sync-driven refresh can
      // otherwise land first (e.g. pollProgress on mount, racing hydration)
      // and open the gate early, letting a physical scan be journaled while
      // the screen's own reconciliation of orphan pending events is still
      // in flight.
      setProductionDate((current) => (current === null ? current : activeDate));
      // This read can resolve after the operator has since opened the date
      // dialog and started typing; only the toolbar display is refreshed
      // here, never an in-progress, unsaved draft.
      if (!dateDialogOpenRef.current) setDateDraft(activeDate);
    }
  }, [deviceId, exec, inventory.inventoryId, inventory.snapshotId]);

  const {
    state: inventorySyncState,
    nudge: nudgeInventorySync,
    idle: inventorySyncIdle,
    stop: stopInventorySync,
    resume: resumeInventorySync,
  } = useInventorySyncEngine({
    exec,
    client: gallery ? null : (client ?? null),
    inventoryId: inventory.inventoryId,
    snapshotId: inventory.snapshotId,
    ...(floorTaskPointerValue ? { floorTaskPointerValue } : {}),
    active: !gallery,
    onProgressApplied: refresh,
    ...(credentialGeneration ? { credentialGeneration } : {}),
  });

  useEffect(() => {
    mounted.current = true;
    if (gallery)
      return () => {
        mounted.current = false;
      };
    void (async () => {
      let stored = await loadInventoryProductionDate(exec, {
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
      });
      if (stored === null) {
        stored = inventory.productionDateFrom;
        await setInventoryProductionDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          productionDate: stored,
          updatedAt: now(),
        });
      }
      const reconciliation = await reconcilePendingInventoryEvents(
        exec,
        inventory.inventoryId,
        inventory.snapshotId,
      );
      await refresh();
      if (mounted.current) {
        setProductionDate(stored);
        setDateDraft(stored);
        setWriteFailed(reconciliation.requiresRescan);
      }
    })().catch((error: unknown) => {
      console.error("station: inventory work hydration failed", error);
      if (mounted.current) setWriteFailed(true);
    });
    return () => {
      mounted.current = false;
    };
  }, [
    deviceId,
    exec,
    inventory.inventoryId,
    inventory.productionDateFrom,
    inventory.snapshotId,
    now,
    operatorId,
    refresh,
    gallery,
  ]);

  const queue = useMemo(
    () =>
      createScanQueue<CheckScanOutcome>({
        shouldProcess: () => !heldRef.current,
        process: async (raw) => {
          const bypass = bypassRef.current === raw;
          if (bypass) bypassRef.current = null;
          const outcome = await recordInventoryScan(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            taskGtin14: inventory.gtin14,
            raw,
            eventId: createEventId(),
            scannedAt: now(),
            ...(bypass ? { acceptSourceDateMismatch: true } : {}),
          });
          return outcome.outcome === "recorded" ? outcome : { ...outcome, raw };
        },
        onOutcome: (outcome) => {
          if (!mounted.current) return;
          setWriteFailed(false);
          if (outcome.outcome === "date-mismatch") {
            heldRef.current = true;
            queueRef.current?.discardBufferedScans();
            // Clear any stale accepted verdict from a prior scan so the floor
            // screen does not keep showing e.g. "Код принят" behind the held
            // dialog for a code that was never recorded (mirrors repack,
            // which sets its own `result` before holding).
            setResult(null);
            setHeldScan(outcome);
            return;
          }
          setResult(outcome);
          nudgeInventorySync();
          void refresh().catch((error: unknown) => {
            console.error("station: inventory progress refresh failed", error);
          });
        },
        onError: (_raw, error) => {
          console.error("station: inventory scan write failed", error);
          if (mounted.current) setWriteFailed(true);
          // guardSourceProductionDate can commit a silent date adoption
          // before reserveEvent/the projection insert throws, so a failed
          // scan can still leave the terminal's persisted date ahead of the
          // toolbar and dateDraft. A later sync poll would self-heal this,
          // but not while offline — exactly when writes are failing.
          void refresh().catch((refreshError: unknown) => {
            console.error("station: inventory progress refresh failed", refreshError);
          });
        },
      }),
    [
      createEventId,
      deviceId,
      exec,
      inventory.gtin14,
      inventory.inventoryId,
      inventory.snapshotId,
      now,
      operatorId,
      refresh,
      nudgeInventorySync,
    ],
  );

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (gallery || productionDate === null) return undefined;
    queue.open();
    const unregister = onScanQueueRegister?.(queue);
    return () => {
      unregister?.();
      void queue.close();
    };
  }, [gallery, onScanQueueRegister, productionDate, queue]);

  useEffect(() => {
    if (gallery || productionDate === null || dateDialog || heldScan) return undefined;
    return source.start((raw) => queue.enqueue(raw));
  }, [dateDialog, gallery, heldScan, productionDate, queue, source]);

  const applyDate = async () => {
    if (dateDraft < inventory.productionDateFrom || dateDraft > inventory.productionDateTo) return;
    await runQueuedJob(queue, () =>
      setInventoryProductionDate(exec, {
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
        operatorId,
        productionDate: dateDraft,
        updatedAt: now(),
      }),
    );
    if (mounted.current) {
      dateWriteVersionRef.current += 1;
      setProductionDate(dateDraft);
      setDateDialog(false);
    }
  };

  const codeDateInRange =
    heldScan?.codeDate !== null &&
    heldScan !== null &&
    heldScan.codeDate >= inventory.productionDateFrom &&
    heldScan.codeDate <= inventory.productionDateTo;

  const releaseHeldScan = () => {
    heldRef.current = false;
    setHeldScan(null);
  };

  /** Queues a terminal-date write behind any buffered scans/jobs, same as `applyDate`. */
  const writeActiveProductionDate = (productionDate: string) =>
    runQueuedJob(queue, () =>
      setInventoryProductionDate(exec, {
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
        operatorId,
        productionDate,
        updatedAt: now(),
      }),
    );

  const adoptHeldDate = async () => {
    // Reentrancy guard for a double-tap landing before React disables the
    // button (finding 2): checked synchronously, so a second invocation in
    // the same tick as the first is a no-op regardless of render timing.
    if (dialogBusyRef.current) return;
    const held = heldScan;
    if (!held || held.codeDate === null) return;
    const codeDate = held.codeDate;
    dialogBusyRef.current = true;
    setDialogBusy(true);
    try {
      await writeActiveProductionDate(codeDate);
      if (!mounted.current) return;
      dateWriteVersionRef.current += 1;
      setProductionDate(codeDate);
      setDateDraft(codeDate);
      releaseHeldScan();
      queue.enqueue(held.raw);
    } finally {
      dialogBusyRef.current = false;
      if (mounted.current) setDialogBusy(false);
    }
  };

  const acceptHeldScan = () => {
    const held = heldScan;
    if (!held) return;
    bypassRef.current = held.raw;
    releaseHeldScan();
    queue.enqueue(held.raw);
  };

  const locale = i18n.language === "ru" ? "ru-RU" : "en-US";
  const formattedDate = productionDate
    ? formatCivilDate(productionDate, locale)
    : t("inventory.work.loadingDate");

  const leave = async () => {
    setLeaving(true);
    setLeaveFailed(false);
    try {
      if (!client) throw new Error("inventory server client is unavailable");
      if (!credentialGeneration || !floorTaskPointerValue) {
        throw new Error("inventory floor task ownership unavailable");
      }
      await leaveInventoryTask({
        exec,
        client,
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
        pointerValue: floorTaskPointerValue,
        credentialGeneration,
        closeScanner: () => queue.close(),
        scanQueueIdle: () => queue.idle(),
        sync: {
          nudge: nudgeInventorySync,
          idle: inventorySyncIdle,
          stop: stopInventorySync,
          resume: resumeInventorySync,
        },
      });
      onLeft?.();
    } catch (error) {
      console.error("station: inventory leave failed", error);
      queue.open();
      if (mounted.current) {
        setLeaveFailed(true);
        setLeaving(false);
      }
    }
  };

  return (
    <StationScreen
      title={t("inventory.work.title")}
      header={
        <div className="inventory-work-heading">
          <span>{inventory.inventoryNumber}</span>
          <strong>{inventory.productPrintName ?? inventory.productName}</strong>
          <span>{t("inventory.modeCheck")}</span>
        </div>
      }
    >
      <div className="inventory-work-screen" data-testid="inventory-simple-work">
        <section className="inventory-active-date">
          <div>
            <span>{t("inventory.work.productionDate")}</span>
            <strong>{formattedDate}</strong>
          </div>
          <span>{t("inventory.work.futureOnly")}</span>
          <Button
            variant="secondary"
            size="floor"
            onClick={() => setDateDialog(true)}
            aria-label={t("inventory.work.changeDate")}
          >
            {t("inventory.work.change")}
          </Button>
          <Button variant="secondary" size="floor" disabled={leaving} onClick={() => void leave()}>
            {leaving ? t("inventory.work.leaving") : t("inventory.work.leave")}
          </Button>
        </section>
        <div role="status" className="inventory-sync-status">
          {leaveFailed
            ? t("inventory.work.leaveFailed")
            : t("inventory.work.pendingSync", {
                count: gallery?.pendingSync ?? inventorySyncState.pending,
              })}
        </div>
        <div className="inventory-work-main">
          <div className="inventory-work-primary">
            <InventoryScanInstrument
              result={result}
              writeFailed={writeFailed}
              currentDeviceId={deviceId}
              labels={{
                prompt: t("inventory.work.prompt"),
                hint: t("inventory.work.promptHint"),
                expected: t("inventory.work.verdict.expected"),
                protected: t("inventory.work.verdict.protected"),
                ineligible: t("inventory.work.verdict.ineligible"),
                unknown: t("inventory.work.verdict.unknown"),
                duplicateHere: t("inventory.work.verdict.duplicateHere"),
                duplicateOther: t("inventory.work.verdict.duplicateOther"),
                terminalHere: t("inventory.work.verdict.terminalHere"),
                terminalOther: t("inventory.work.verdict.terminalOther"),
                invalid: t("inventory.work.verdict.invalid"),
                writeFailed: t("inventory.work.verdict.writeFailed"),
                boxAccepted: (count) => t("inventory.work.verdict.boxAccepted", { count }),
                boxBadge: t("inventory.work.badge.box"),
                duplicateBadge: t("inventory.work.badge.duplicate"),
                protectedBadge: t("inventory.work.badge.protected"),
                discrepancyBadge: t("inventory.work.badge.discrepancy"),
                ineligibleBadge: t("inventory.work.badge.ineligible"),
              }}
            />
            <InventoryProgressView
              progress={progress}
              recent={[]}
              variant="summary"
              gtin14={inventory.gtin14}
              locale={locale}
              labels={{
                verified: t("inventory.work.progress.verified"),
                discrepancies: t("inventory.work.progress.discrepancies"),
                protected: t("inventory.work.progress.protected"),
                terminal: t("inventory.work.progress.terminal"),
                boxes: t("inventory.work.progress.boxes"),
                items: t("inventory.work.progress.items"),
                recent: t("inventory.work.recent"),
                empty: t("inventory.work.emptyRecent"),
                invalidTime: t("inventory.work.invalidTime"),
                gtin: "GTIN",
                serial: t("inventory.work.serial"),
                status: {
                  expected: t("inventory.work.status.expected"),
                  protected: t("inventory.work.status.protected"),
                  "known-ineligible": t("inventory.work.status.ineligible"),
                  unknown: t("inventory.work.status.unknown"),
                  duplicate: t("inventory.work.status.duplicate"),
                },
              }}
            />
          </div>
          <aside className="inventory-work-recent">
            <InventoryProgressView
              progress={EMPTY_PROGRESS}
              recent={recent}
              variant="recent"
              gtin14={inventory.gtin14}
              locale={locale}
              labels={{
                verified: t("inventory.work.progress.verified"),
                discrepancies: t("inventory.work.progress.discrepancies"),
                protected: t("inventory.work.progress.protected"),
                terminal: t("inventory.work.progress.terminal"),
                boxes: t("inventory.work.progress.boxes"),
                items: t("inventory.work.progress.items"),
                recent: t("inventory.work.recent"),
                empty: t("inventory.work.emptyRecent"),
                invalidTime: t("inventory.work.invalidTime"),
                gtin: "GTIN",
                serial: t("inventory.work.serial"),
                status: {
                  expected: t("inventory.work.status.expected"),
                  protected: t("inventory.work.status.protected"),
                  "known-ineligible": t("inventory.work.status.ineligible"),
                  unknown: t("inventory.work.status.unknown"),
                  duplicate: t("inventory.work.status.duplicate"),
                },
              }}
            />
          </aside>
        </div>
      </div>
      <FullScreenDialog
        open={dateDialog}
        title={t("inventory.work.dateDialogTitle")}
        backLabel={t("inventory.work.cancel")}
        onClose={() => setDateDialog(false)}
        footer={
          <Button
            size="floor"
            onClick={() =>
              void applyDate().catch((error: unknown) => {
                console.error("station: inventory date update failed", error);
                if (mounted.current) {
                  setWriteFailed(true);
                  setDateDialog(false);
                }
              })
            }
          >
            {t("inventory.work.applyDate")}
          </Button>
        }
      >
        <div className="inventory-date-dialog">
          <label htmlFor="inventory-production-date">{t("inventory.work.productionDate")}</label>
          <input
            id="inventory-production-date"
            type="date"
            min={inventory.productionDateFrom}
            max={inventory.productionDateTo}
            value={dateDraft}
            onChange={(event) => setDateDraft(event.currentTarget.value)}
          />
          <p>{t("inventory.work.futureOnly")}</p>
        </div>
      </FullScreenDialog>
      <FullScreenDialog
        open={heldScan !== null}
        title={
          heldScan?.mixed
            ? t("inventory.work.sourceDate.mixedTitle")
            : t("inventory.work.sourceDate.title")
        }
        backLabel={t("inventory.work.sourceDate.skip")}
        backPlacement="footer"
        backDisabled={dialogBusy}
        onClose={releaseHeldScan}
        footer={
          heldScan?.mixed ? (
            <Button size="floor" disabled={dialogBusy} onClick={acceptHeldScan}>
              {t("inventory.work.sourceDate.accept")}
            </Button>
          ) : codeDateInRange ? (
            <Button
              size="floor"
              disabled={dialogBusy}
              onClick={() =>
                void adoptHeldDate().catch((error: unknown) => {
                  console.error("station: inventory date adoption failed", error);
                  if (mounted.current) {
                    setWriteFailed(true);
                    releaseHeldScan();
                  }
                })
              }
            >
              {t("inventory.work.sourceDate.apply", {
                date: heldScan?.codeDate ? formatCivilDate(heldScan.codeDate, locale) : "",
              })}
            </Button>
          ) : null
        }
      >
        <div className="inventory-date-dialog inventory-date-dialog--compare">
          {heldScan?.mixed ? (
            <>
              <div className="inventory-date-compare inventory-date-compare--single">
                <div className="inventory-date-compare__block">
                  <span>{t("inventory.work.sourceDate.activeLabel")}</span>
                  <strong>{heldScan ? formatCivilDate(heldScan.activeDate, locale) : "—"}</strong>
                </div>
              </div>
              <p>{t("inventory.work.sourceDate.mixedBody")}</p>
            </>
          ) : (
            <>
              <div className="inventory-date-compare">
                <div className="inventory-date-compare__block inventory-date-compare__block--warn">
                  <span>{t("inventory.work.sourceDate.codeLabel")}</span>
                  <strong>
                    {heldScan?.codeDate ? formatCivilDate(heldScan.codeDate, locale) : "—"}
                  </strong>
                </div>
                <div className="inventory-date-compare__block">
                  <span>{t("inventory.work.sourceDate.activeLabel")}</span>
                  <strong>{heldScan ? formatCivilDate(heldScan.activeDate, locale) : "—"}</strong>
                </div>
              </div>
              {!codeDateInRange ? <p>{t("inventory.work.sourceDate.outOfRange")}</p> : null}
            </>
          )}
        </div>
      </FullScreenDialog>
    </StationScreen>
  );
}

const EMPTY_REPACK_STATE: InventoryRepackStateView = { phase: "awaiting-old-box", box: null };

type HeldRepackScan = { raw: string; boxDate: string; codeDate: string; itemCount: number };

function RepackInventoryWorkScreen({
  exec,
  inventory,
  deviceId,
  operatorId,
  source,
  client,
  credentialGeneration,
  floorTaskPointerValue,
  onLeft,
  onScanQueueRegister,
  printing = null,
  onOpenPrinterSetup,
  onPrintRecoveryChange,
  createEventId = defaultEventId,
  now = defaultNow,
  galleryState,
}: InventoryWorkScreenProps & {
  inventory: StationInventoryBundleManifest & { mode: "repack" };
}) {
  const { t, i18n } = useTranslation();
  const gallery = galleryState?.mode === "repack" ? galleryState : null;
  const [productionDate, setProductionDate] = useState<string | null>(
    gallery?.productionDate ?? null,
  );
  const [dateDraft, setDateDraft] = useState(
    gallery?.productionDate ?? inventory.productionDateFrom,
  );
  const [state, setState] = useState<InventoryRepackStateView>(
    gallery?.state ?? EMPTY_REPACK_STATE,
  );
  const [result, setResult] = useState<InventoryRepackScanResult | null>(gallery?.result ?? null);
  const [recent, setRecent] = useState<RecentInventoryOperation[]>(gallery?.recent ?? []);
  const [writeFailed, setWriteFailed] = useState(gallery?.writeFailed ?? false);
  const [dateDialog, setDateDialog] = useState(gallery?.dateDialog ?? false);
  // Read synchronously (not via effect) so the `old-box-selected` date
  // reload below always sees the dialog state as of the render that is
  // current when its promise resolves, not one render behind.
  const dateDialogOpenRef = useRef(dateDialog);
  dateDialogOpenRef.current = dateDialog;
  const [correctionsDialog, setCorrectionsDialog] = useState(gallery?.correctionsDialog ?? false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(gallery?.leaveFailed ?? false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printRecoveryHydrated, setPrintRecoveryHydrated] = useState(Boolean(gallery));
  const [printResult, setPrintResult] = useState<InventoryBoxPrintResult | null>(null);
  const [unresolvedReprint, setUnresolvedReprint] = useState<UnresolvedInventoryReprint | null>(
    null,
  );
  const [provisionalPrintFailure, setProvisionalPrintFailure] =
    useState<InventoryPrintDisplay | null>(gallery?.printDisplay ?? null);
  const [reprintSscc, setReprintSscc] = useState(gallery?.reprintSscc ?? "");
  const [reprintMatches, setReprintMatches] = useState<InventoryPrintedBoxMatch[] | null>(
    gallery?.reprintMatches ?? null,
  );
  const mounted = useRef(true);
  const automaticPrints = useRef(new Set<string>());
  const automaticRecoveries = useRef(new Set<string>());
  const printInvocationBusy = useRef(false);
  const remoteReprintBusy = useRef(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [heldScan, setHeldScan] = useState<HeldRepackScan | null>(gallery?.heldScan ?? null);
  const heldRef = useRef(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const dialogBusyRef = useRef(false);
  const queueRef = useRef<ScanQueue | null>(null);
  const boxDateRef = useRef("");

  const refresh = useCallback(async () => {
    const [nextState, nextRecent, nextReprint] = await Promise.all([
      readInventoryRepackState(exec, inventory.inventoryId, inventory.snapshotId, deviceId),
      listRecentInventoryOperations(exec, inventory.inventoryId, inventory.snapshotId),
      readUnresolvedInventoryReprint(exec, {
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
      }),
    ]);
    if (mounted.current) {
      setState(nextState);
      setRecent(nextRecent);
      setUnresolvedReprint(nextReprint);
      setRefreshRevision((current) => current + 1);
    }
  }, [deviceId, exec, inventory.inventoryId, inventory.snapshotId]);
  boxDateRef.current = state.box?.productionDate ?? "";

  const {
    state: syncState,
    nudge,
    idle,
    stop,
    resume,
  } = useInventorySyncEngine({
    exec,
    client: gallery ? null : (client ?? null),
    inventoryId: inventory.inventoryId,
    snapshotId: inventory.snapshotId,
    ...(floorTaskPointerValue ? { floorTaskPointerValue } : {}),
    active: !gallery,
    onProgressApplied: refresh,
    ...(credentialGeneration ? { credentialGeneration } : {}),
  });

  useEffect(() => {
    mounted.current = true;
    if (gallery)
      return () => {
        mounted.current = false;
      };
    void (async () => {
      let date = await loadInventoryProductionDate(exec, {
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
      });
      if (date === null) {
        date = inventory.productionDateFrom;
        await setInventoryProductionDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          productionDate: date,
          updatedAt: now(),
        });
      }
      await refresh();
      if (mounted.current) {
        setProductionDate(date);
        setDateDraft(date);
        setPrintRecoveryHydrated(true);
      }
    })().catch((error: unknown) => {
      console.error("station: repack hydration failed", error);
      if (mounted.current) setWriteFailed(true);
    });
    return () => {
      mounted.current = false;
    };
  }, [
    deviceId,
    exec,
    inventory.inventoryId,
    inventory.productionDateFrom,
    inventory.snapshotId,
    now,
    operatorId,
    refresh,
    gallery,
  ]);

  const queue = useMemo(
    () =>
      createScanQueue<{ outcome: InventoryRepackScanResult; raw: string }>({
        shouldProcess: () => !heldRef.current,
        process: async (raw) =>
          recordInventoryRepackScan(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            taskGtin14: inventory.gtin14,
            issuerPrefix: inventory.sscc?.issuerPrefix ?? "",
            capacity: inventory.boxCapacity,
            raw,
            eventId: createEventId(),
            scannedAt: now(),
          }).then((outcome) => ({ outcome, raw })),
        onOutcome: ({ outcome, raw }) => {
          if (!mounted.current) return;
          setWriteFailed(false);
          if (outcome.verdict === "source-date-mismatch" && outcome.sourceProductionDate) {
            heldRef.current = true;
            queueRef.current?.discardBufferedScans();
            setResult(outcome);
            setHeldScan({
              raw,
              boxDate: boxDateRef.current,
              codeDate: outcome.sourceProductionDate,
              // Authoritative as of this outcome's own DB read — unlike
              // `state.box.itemCount`, which can still be lagging behind an
              // accepted add or a just-opened box (see the back-to-back scan
              // test), because `refresh()` is fired-and-forget from the
              // previous outcome and may not have committed yet.
              itemCount: outcome.itemCount,
            });
            return;
          }
          if (outcome.verdict === "old-box-selected") {
            setPrintResult(null);
            setProvisionalPrintFailure(null);
            // Task 4's seeding can move the terminal's active date to the old
            // box's own content date; refresh() only reloads box/recent/print
            // state, so the toolbar's productionDate/dateDraft must be synced
            // from the persisted terminal state here or they keep showing the
            // stale value — and a later "apply date" on the still-empty box
            // would write that stale date back, un-doing the seed.
            void loadInventoryProductionDate(exec, {
              inventoryId: inventory.inventoryId,
              snapshotId: inventory.snapshotId,
              deviceId,
            })
              .then((date) => {
                if (mounted.current && date !== null) {
                  setProductionDate(date);
                  // Scans (and therefore this reload) cannot be enqueued
                  // while the date dialog is open, but this read can still
                  // resolve after the operator has since opened it and
                  // started typing; only the toolbar display is refreshed
                  // here, never an in-progress, unsaved draft.
                  if (!dateDialogOpenRef.current) setDateDraft(date);
                }
              })
              .catch((error: unknown) => {
                console.error("station: repack toolbar date refresh failed", error);
              });
          }
          if (outcome.verdict === "capacity-closed") setPrintBusy(true);
          setResult(outcome);
          nudge();
          void refresh();
        },
        onError: (_raw, error) => {
          console.error("station: repack scan write failed", error);
          if (mounted.current) setWriteFailed(true);
        },
      }),
    [
      createEventId,
      deviceId,
      exec,
      inventory.boxCapacity,
      inventory.gtin14,
      inventory.inventoryId,
      inventory.snapshotId,
      inventory.sscc?.issuerPrefix,
      now,
      operatorId,
      nudge,
      refresh,
    ],
  );

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    if (gallery || productionDate === null) return undefined;
    queue.open();
    const unregister = onScanQueueRegister?.(queue);
    return () => {
      unregister?.();
      void queue.close();
    };
  }, [gallery, onScanQueueRegister, productionDate, queue]);

  const unresolvedPrint =
    state.phase === "closed-pending-print" ||
    state.box?.printState === "printing" ||
    unresolvedReprint !== null ||
    provisionalPrintFailure !== null ||
    printResult?.state === "failed";
  const printRecoveryBlocked = !printRecoveryHydrated || unresolvedPrint || printBusy;
  const recoveryCallbackRef = useRef(onPrintRecoveryChange);
  recoveryCallbackRef.current = onPrintRecoveryChange;
  useEffect(() => {
    recoveryCallbackRef.current?.(printRecoveryBlocked);
  }, [printRecoveryBlocked]);
  useEffect(
    () => () => {
      recoveryCallbackRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (
      gallery ||
      productionDate === null ||
      dateDialog ||
      correctionsDialog ||
      unresolvedPrint ||
      printBusy ||
      heldScan
    ) {
      return undefined;
    }
    return source.start((raw) => queue.enqueue(raw));
  }, [
    correctionsDialog,
    dateDialog,
    gallery,
    heldScan,
    printBusy,
    productionDate,
    queue,
    source,
    unresolvedPrint,
  ]);

  useEffect(() => {
    if (gallery || !correctionsDialog || printBusy) return undefined;
    return source.start((raw) => {
      const sscc = parseScannedSscc(raw);
      if (sscc !== null) setReprintSscc(sscc);
    });
  }, [correctionsDialog, gallery, printBusy, source]);

  const runPrint = useCallback(
    async (
      boxId: string,
      kind: "initial" | "reprint" = "initial",
      recoveryOfAttemptId?: string,
    ) => {
      if (printInvocationBusy.current) return null;
      printInvocationBusy.current = true;
      setPrintBusy(true);
      setProvisionalPrintFailure(null);
      const attemptId = createEventId();
      try {
        await queue.idle();
        const attemptedAt = now();
        const outcome = await attemptInventoryBoxPrint({
          exec,
          manifest: inventory,
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          boxId,
          attemptId,
          eventId: createEventId(),
          attemptedAt,
          completedAt: now,
          printing,
          kind,
          ...(recoveryOfAttemptId ? { recoveryOfAttemptId } : {}),
        });
        if (mounted.current) {
          setPrintResult(outcome);
          setWriteFailed(false);
        }
        nudge();
        await refresh();
        return outcome;
      } catch (error) {
        if (error instanceof InventoryPrintRecoveryStaleError) {
          await refresh();
          return null;
        }
        console.error("station: inventory box print persistence failed");
        let attempts = await listInventoryBoxPrintAttempts(
          exec,
          inventory.inventoryId,
          inventory.snapshotId,
          boxId,
        );
        let latest = attempts.find((attempt) => attempt.attemptId === attemptId) ?? null;
        if (latest?.state === "printing") {
          try {
            await recoverInterruptedInventoryPrint(exec, {
              inventoryId: inventory.inventoryId,
              snapshotId: inventory.snapshotId,
              deviceId,
              operatorId,
              boxId,
              attemptId: latest.attemptId,
              eventId: createEventId(),
              completedAt: now(),
            });
            attempts = await listInventoryBoxPrintAttempts(
              exec,
              inventory.inventoryId,
              inventory.snapshotId,
              boxId,
            );
            latest = attempts.find((attempt) => attempt.attemptId === attemptId) ?? latest;
          } catch {
            console.error("station: inventory print recovery persistence failed");
          }
        }
        const facts = await readInventoryBoxPrintFacts(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          boxId,
        });
        if (mounted.current) {
          setWriteFailed(true);
          if (facts) {
            setProvisionalPrintFailure({
              ...facts,
              attemptId: latest?.attemptId ?? recoveryOfAttemptId ?? null,
              attemptNumber: latest?.attemptNumber ?? 0,
              attemptState:
                latest?.state === "printing" || latest?.state === "failed" ? latest.state : null,
              kind,
              state: "failed",
              errorCode: latest?.errorCode ?? "persistence_failed",
            });
          }
        }
        await refresh();
        return null;
      } finally {
        printInvocationBusy.current = false;
        if (mounted.current) setPrintBusy(false);
      }
    },
    [createEventId, deviceId, exec, inventory, now, operatorId, printing, queue, nudge, refresh],
  );

  useEffect(() => {
    if (gallery || printInvocationBusy.current || unresolvedReprint || remoteReprintBusy.current)
      return;
    remoteReprintBusy.current = true;
    void (async () => {
      setPrintBusy(true);
      try {
        await queue.idle();
        const outcome = await processNextInventoryRemoteReprint({
          exec,
          manifest: inventory,
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          createEventId,
          now,
          printing,
        });
        if (outcome && mounted.current) {
          setPrintResult(outcome);
          setWriteFailed(false);
          nudge();
          await refresh();
        }
      } catch {
        console.error("station: remote inventory reprint failed");
        if (mounted.current) setWriteFailed(true);
      } finally {
        remoteReprintBusy.current = false;
        if (mounted.current) setPrintBusy(false);
      }
    })();
  }, [
    createEventId,
    deviceId,
    exec,
    gallery,
    inventory,
    now,
    nudge,
    operatorId,
    printing,
    queue,
    refresh,
    refreshRevision,
    unresolvedReprint,
  ]);

  useEffect(() => {
    const box = state.box;
    if (gallery || !box || state.phase !== "closed-pending-print") return;
    const key = `${box.boxId}:${box.printState}`;
    if (automaticPrints.current.has(key)) return;
    automaticPrints.current.add(key);
    if (box.printState === "pending") {
      void runPrint(box.boxId);
      return;
    }
    if (box.printState === "printing") {
      void (async () => {
        setPrintBusy(true);
        try {
          const attempts = await listInventoryBoxPrintAttempts(
            exec,
            inventory.inventoryId,
            inventory.snapshotId,
            box.boxId,
          );
          const interrupted = attempts.findLast((attempt) => attempt.state === "printing");
          if (interrupted) {
            await recoverInterruptedInventoryPrint(exec, {
              inventoryId: inventory.inventoryId,
              snapshotId: inventory.snapshotId,
              deviceId,
              operatorId,
              boxId: box.boxId,
              attemptId: interrupted.attemptId,
              eventId: createEventId(),
              completedAt: now(),
            });
            setPrintResult({
              attemptId: interrupted.attemptId,
              boxId: box.boxId,
              kind: interrupted.kind,
              state: "failed",
              errorCode: "persistence_failed",
              sscc: box.newSscc,
              quantity: box.itemCount,
              productionDate: box.productionDate,
              attemptNumber: interrupted.attemptNumber,
            });
          }
          nudge();
          await refresh();
        } catch {
          console.error("station: inventory print recovery persistence failed");
          if (mounted.current) setWriteFailed(true);
        } finally {
          if (mounted.current) setPrintBusy(false);
        }
      })();
    }
  }, [
    createEventId,
    deviceId,
    exec,
    inventory.inventoryId,
    inventory.snapshotId,
    now,
    operatorId,
    nudge,
    refresh,
    runPrint,
    state,
    gallery,
  ]);

  useEffect(() => {
    if (gallery || !unresolvedReprint || unresolvedReprint.attemptState !== "printing" || printBusy)
      return;
    if (automaticRecoveries.current.has(unresolvedReprint.attemptId)) return;
    automaticRecoveries.current.add(unresolvedReprint.attemptId);
    void (async () => {
      setPrintBusy(true);
      try {
        await recoverInterruptedInventoryPrint(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          boxId: unresolvedReprint.boxId,
          attemptId: unresolvedReprint.attemptId,
          eventId: createEventId(),
          completedAt: now(),
        });
        setProvisionalPrintFailure({
          ...unresolvedReprint,
          state: "failed",
          attemptState: "failed",
          errorCode: "persistence_failed",
        });
        nudge();
        await refresh();
      } catch {
        console.error("station: inventory reprint recovery persistence failed");
        if (mounted.current) {
          setProvisionalPrintFailure({
            ...unresolvedReprint,
            state: "failed",
            errorCode: "persistence_failed",
          });
          setWriteFailed(true);
        }
      } finally {
        if (mounted.current) setPrintBusy(false);
      }
    })();
  }, [
    createEventId,
    deviceId,
    exec,
    inventory.inventoryId,
    inventory.snapshotId,
    now,
    nudge,
    operatorId,
    printBusy,
    refresh,
    unresolvedReprint,
    gallery,
  ]);

  const runCorrection = async (kind: "remove" | "clear" | "resolve-conflict") => {
    setBusy(true);
    try {
      await runQueuedJob(queue, async () => {
        const input = {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          eventId: createEventId(),
          changedAt: now(),
        };
        if (kind === "remove") {
          await removeLastInventoryRepackItem(exec, input);
        } else if (kind === "resolve-conflict") {
          await resolveInvalidatedInventoryRepackBox(exec, {
            ...input,
            reason: "claim-lost",
          });
        } else {
          await clearOpenInventoryRepackBox(exec, input);
        }
      });
      nudge();
      await refresh();
      if (mounted.current) setCorrectionsDialog(false);
    } catch (error) {
      console.error("station: repack correction failed", error);
      if (mounted.current) {
        setWriteFailed(true);
        setCorrectionsDialog(false);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const reprint = async (match: InventoryPrintedBoxMatch) => {
    await runPrint(match.boxId, "reprint");
    if (mounted.current) {
      setCorrectionsDialog(false);
      setReprintMatches(null);
      setReprintSscc("");
    }
  };

  // Live reprint lookup: matches appear as the operator types a fragment.
  useEffect(() => {
    if (gallery) return undefined;
    if (!correctionsDialog || reprintSscc.length < REPACK_REPRINT_MIN_QUERY) {
      setReprintMatches(null);
      return undefined;
    }
    // Drop the previous query's matches immediately so a stale row cannot be
    // tapped while the lookup for the new fragment is still in flight.
    setReprintMatches(null);
    let cancelled = false;
    void searchInventoryPrintedBoxesBySscc(exec, {
      inventoryId: inventory.inventoryId,
      snapshotId: inventory.snapshotId,
      deviceId,
      fragment: reprintSscc,
    }).then((matches) => {
      if (!cancelled && mounted.current) setReprintMatches(matches);
    });
    return () => {
      cancelled = true;
    };
  }, [
    correctionsDialog,
    deviceId,
    exec,
    gallery,
    inventory.inventoryId,
    inventory.snapshotId,
    reprintSscc,
  ]);

  const retryPrint = async (recovery: InventoryPrintDisplay) => {
    if (recovery.attemptState === "printing" && recovery.attemptId) {
      setPrintBusy(true);
      try {
        await recoverInterruptedInventoryPrint(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          boxId: recovery.boxId,
          attemptId: recovery.attemptId,
          eventId: createEventId(),
          completedAt: now(),
        });
        nudge();
        await refresh();
      } catch {
        console.error("station: inventory print retry recovery persistence failed");
        if (mounted.current) {
          setProvisionalPrintFailure({
            ...recovery,
            state: "failed",
            errorCode: "persistence_failed",
          });
          setWriteFailed(true);
        }
        return;
      } finally {
        if (mounted.current) setPrintBusy(false);
      }
    }
    await runPrint(
      recovery.boxId,
      recovery.kind,
      recovery.kind === "reprint" ? (recovery.attemptId ?? undefined) : undefined,
    );
  };

  const applyDate = async () => {
    if (
      (state.box && state.box.itemCount > 0) ||
      dateDraft < inventory.productionDateFrom ||
      dateDraft > inventory.productionDateTo
    )
      return;
    await runQueuedJob(queue, async () => {
      if (state.box) {
        await changeOpenInventoryRepackDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          eventId: createEventId(),
          changedAt: now(),
          productionDate: dateDraft,
        });
        // Redundant for the date itself: the `inventory_repack_apply_journal_v1`
        // trigger already moves inventory_terminal_state.active_production_date
        // on every change-date journal row. Kept because it also carries
        // operator_id, which the trigger does not touch, and because the
        // terminal-vs-box `dateMatches` check in inventory-repacking.ts is a
        // load-bearing invariant that should be visible here rather than
        // resting entirely on an invisible trigger. Mirrors `adoptHeldDate`.
        await setInventoryProductionDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          productionDate: dateDraft,
          updatedAt: now(),
        });
        nudge();
      } else {
        await setInventoryProductionDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          productionDate: dateDraft,
          updatedAt: now(),
        });
      }
    });
    await refresh();
    if (mounted.current) {
      setProductionDate(dateDraft);
      setDateDialog(false);
    }
  };

  const releaseHeldScan = () => {
    heldRef.current = false;
    setHeldScan(null);
  };

  const adoptHeldDate = async () => {
    // Reentrancy guard for a double-tap landing before React disables the
    // button: checked synchronously, so a second invocation in the same tick
    // as the first is a no-op regardless of render timing.
    if (dialogBusyRef.current) return;
    const held = heldScan;
    if (!held || held.itemCount > 0) return;
    dialogBusyRef.current = true;
    setDialogBusy(true);
    try {
      // Not range-checked against [productionDateFrom, productionDateTo]
      // here: `held.codeDate` only ever comes from an `expected` row's
      // source-date mismatch, and inventory-mirror.ts's bundle validation
      // (classifyInventorySnapshotRow against the manifest's range) already
      // guarantees those are in range.
      await runQueuedJob(queue, async () => {
        await changeOpenInventoryRepackDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          eventId: createEventId(),
          changedAt: now(),
          productionDate: held.codeDate,
        });
        await setInventoryProductionDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          productionDate: held.codeDate,
          updatedAt: now(),
        });
      });
      nudge();
      await refresh();
      if (!mounted.current) return;
      setProductionDate(held.codeDate);
      setDateDraft(held.codeDate);
      releaseHeldScan();
      queue.enqueue(held.raw);
    } finally {
      dialogBusyRef.current = false;
      if (mounted.current) setDialogBusy(false);
    }
  };

  const leave = async () => {
    setLeaving(true);
    setLeaveFailed(false);
    try {
      if (!client || !credentialGeneration || !floorTaskPointerValue) {
        throw new Error("inventory floor task ownership unavailable");
      }
      await leaveInventoryTask({
        exec,
        client,
        inventoryId: inventory.inventoryId,
        snapshotId: inventory.snapshotId,
        deviceId,
        pointerValue: floorTaskPointerValue,
        credentialGeneration,
        closeScanner: () => queue.close(),
        scanQueueIdle: () => queue.idle(),
        sync: { nudge, idle, stop, resume },
      });
      onLeft?.();
    } catch (error) {
      console.error("station: repack leave failed", error);
      queue.open();
      if (mounted.current) {
        setLeaveFailed(true);
        setLeaving(false);
      }
    }
  };

  const locale = i18n.language === "ru" ? "ru-RU" : "en-US";
  const formattedDate = productionDate
    ? formatCivilDate(productionDate, locale)
    : t("inventory.work.loadingDate");
  const durableReprintDisplay: InventoryPrintDisplay | null = unresolvedReprint
    ? {
        ...unresolvedReprint,
        state: unresolvedReprint.attemptState === "printing" ? "printing" : "failed",
      }
    : null;
  const resultDisplay: InventoryPrintDisplay | null = printResult
    ? { ...printResult, attemptState: null }
    : null;
  const initialDisplay: InventoryPrintDisplay | null =
    state.phase === "closed-pending-print" && state.box
      ? {
          attemptId: null,
          boxId: state.box.boxId,
          kind: "initial",
          state: state.box.printState === "failed" ? "failed" : "printing",
          attemptState: state.box.printState === "printing" ? "printing" : null,
          errorCode: printErrorCode(state.box.printErrorCode),
          sscc: state.box.newSscc,
          quantity: state.box.itemCount,
          productionDate: state.box.productionDate,
          attemptNumber: 0,
        }
      : null;
  const printDisplay =
    provisionalPrintFailure ?? durableReprintDisplay ?? resultDisplay ?? initialDisplay;
  return (
    <StationScreen
      title={t("inventory.repack.title")}
      header={
        <div className="inventory-work-heading">
          <span>{inventory.inventoryNumber}</span>
          <strong>{inventory.productPrintName ?? inventory.productName}</strong>
          <span>{t("inventory.modeRepack")}</span>
        </div>
      }
    >
      <div className="repack-work-screen" data-testid="inventory-repack-work">
        <div className="repack-toolbar">
          <div>
            <span>{t("inventory.work.productionDate")}</span>
            <strong>{formattedDate}</strong>
          </div>
          <span role="status">
            {leaveFailed
              ? t("inventory.work.leaveFailed")
              : t("inventory.work.pendingSync", {
                  count: gallery?.pendingSync ?? syncState.pending,
                })}
          </span>
          <Button
            size="floor"
            variant="secondary"
            disabled={unresolvedPrint || printBusy}
            onClick={() => setDateDialog(true)}
          >
            {t("inventory.work.change")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            disabled={busy || unresolvedPrint || printBusy}
            onClick={() => setCorrectionsDialog(true)}
          >
            {t("inventory.repack.corrections")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            disabled={leaving || unresolvedPrint || printBusy}
            onClick={() => void leave()}
          >
            {leaving ? t("inventory.work.leaving") : t("inventory.work.leave")}
          </Button>
        </div>
        <div className="repack-work-main">
          {printDisplay ? (
            <InventoryBoxPrintRecovery
              state={printDisplay.state}
              facts={{
                ...printDisplay,
                productionDate: formatCivilDate(printDisplay.productionDate, locale),
              }}
              errorCode={printDisplay.errorCode}
              busy={printBusy}
              onRetry={() => void retryPrint(printDisplay)}
              {...(onOpenPrinterSetup ? { onSetup: onOpenPrinterSetup } : {})}
              labels={{
                printing: t("inventory.repack.print.printing"),
                printed: t("inventory.repack.print.printed"),
                failed: t("inventory.repack.print.failed"),
                sscc: "SSCC",
                quantity: t("inventory.repack.print.quantity"),
                productionDate: t("inventory.work.productionDate"),
                retry: t("inventory.repack.print.retry"),
                setup: t("inventory.repack.print.setup"),
                errors: {
                  template_missing: t("inventory.repack.print.errors.templateMissing"),
                  printer_unconfigured: t("inventory.repack.print.errors.printerUnconfigured"),
                  render_failed: t("inventory.repack.print.errors.renderFailed"),
                  transport_failed: t("inventory.repack.print.errors.transportFailed"),
                  persistence_failed: t("inventory.repack.print.errors.persistenceFailed"),
                },
              }}
            />
          ) : (
            <RepackBoxInstrument
              state={state}
              result={result}
              writeFailed={writeFailed}
              capacity={inventory.boxCapacity}
              labels={{
                oldBox: t("inventory.repack.oldBox"),
                newBox: t("inventory.repack.newBox"),
                productionDate: t("inventory.work.productionDate"),
                awaiting: t("inventory.repack.awaiting"),
                scanning: t("inventory.repack.scanning"),
                pendingPrint: t("inventory.repack.pendingPrint"),
                invalidated: t("inventory.repack.invalidated"),
                adminInvalidated: t("inventory.repack.adminInvalidated"),
                oldSelected: t("inventory.repack.oldSelected"),
                accepted: t("inventory.repack.accepted"),
                discrepancy: t("inventory.repack.discrepancy"),
                sourceDateMismatch: t("inventory.repack.sourceDateMismatch"),
                writeFailed: t("inventory.work.verdict.writeFailed"),
                position: (position, filled) =>
                  t("inventory.repack.position", {
                    position,
                    status: filled ? t("inventory.repack.occupied") : t("inventory.repack.free"),
                  }),
                formatDate: (value) => formatCivilDate(value, locale),
              }}
            />
          )}
          <aside className="inventory-work-recent">
            <InventoryProgressView
              progress={EMPTY_PROGRESS}
              recent={recent}
              variant="recent"
              gtin14={inventory.gtin14}
              locale={locale}
              labels={{
                verified: t("inventory.work.progress.verified"),
                discrepancies: t("inventory.work.progress.discrepancies"),
                protected: t("inventory.work.progress.protected"),
                terminal: t("inventory.work.progress.terminal"),
                boxes: t("inventory.work.progress.boxes"),
                items: t("inventory.work.progress.items"),
                recent: t("inventory.work.recent"),
                empty: t("inventory.work.emptyRecent"),
                invalidTime: t("inventory.work.invalidTime"),
                gtin: "GTIN",
                serial: t("inventory.work.serial"),
                status: {
                  expected: t("inventory.work.status.expected"),
                  protected: t("inventory.work.status.protected"),
                  "known-ineligible": t("inventory.work.status.ineligible"),
                  unknown: t("inventory.work.status.unknown"),
                  duplicate: t("inventory.work.status.duplicate"),
                },
              }}
            />
          </aside>
        </div>
      </div>
      <FullScreenDialog
        open={correctionsDialog}
        title={t("inventory.repack.corrections")}
        backLabel={t("inventory.work.cancel")}
        onClose={() => setCorrectionsDialog(false)}
      >
        <RepackCorrections
          itemCount={state.box?.itemCount ?? 0}
          claimLostConflict={
            state.phase === "invalidated" && state.box?.invalidationSource === "claim_lost"
          }
          compositionBlocked={state.phase === "invalidated"}
          busy={busy}
          onRemoveLast={() => void runCorrection("remove")}
          onClear={() => void runCorrection("clear")}
          onResolveConflict={() => void runCorrection("resolve-conflict")}
          reprintQuery={reprintSscc}
          onReprintQueryChange={setReprintSscc}
          reprintMatches={
            reprintMatches
              ? reprintMatches.map((match) => ({
                  ...match,
                  productionDate: formatCivilDate(match.productionDate, locale),
                }))
              : null
          }
          onReprint={(match) => void reprint(match)}
          labels={{
            removeLast: t("inventory.repack.removeLast"),
            clear: t("inventory.repack.clear"),
            resolveConflict: t("inventory.repack.resolveConflict"),
            empty: t("inventory.repack.empty"),
            openBoxTitle: t("inventory.repack.openBoxTitle"),
            reprintTitle: t("inventory.repack.reprint.title"),
            reprintSscc: t("inventory.repack.reprint.sscc"),
            reprintHint: t("inventory.repack.reprint.hint"),
            noMatches: t("inventory.repack.reprint.noMatches"),
            reprint: t("inventory.repack.reprint.action"),
            quantity: t("inventory.repack.print.quantity"),
            keypad: t("inventory.repack.reprint.keypad"),
            keypadBackspace: t("inventory.repack.reprint.keypadBackspace"),
            keypadClear: t("inventory.repack.reprint.keypadClear"),
          }}
        />
      </FullScreenDialog>
      <FullScreenDialog
        open={dateDialog}
        title={t("inventory.work.dateDialogTitle")}
        backLabel={t("inventory.work.cancel")}
        onClose={() => setDateDialog(false)}
        footer={
          <Button
            size="floor"
            disabled={
              Boolean(state.box && state.box.itemCount > 0) ||
              dateDraft < inventory.productionDateFrom ||
              dateDraft > inventory.productionDateTo
            }
            onClick={() =>
              void applyDate().catch((error: unknown) => {
                console.error("station: repack date change failed", error);
                if (mounted.current) {
                  setWriteFailed(true);
                  setDateDialog(false);
                }
              })
            }
          >
            {t("inventory.work.applyDate")}
          </Button>
        }
      >
        <div className="inventory-date-dialog">
          <label htmlFor="inventory-repack-production-date">
            {t("inventory.work.productionDate")}
          </label>
          <input
            id="inventory-repack-production-date"
            type="date"
            min={inventory.productionDateFrom}
            max={inventory.productionDateTo}
            value={dateDraft}
            onChange={(event) => setDateDraft(event.currentTarget.value)}
          />
          {state.box && state.box.itemCount > 0 ? <p>{t("inventory.repack.dateBlocked")}</p> : null}
        </div>
      </FullScreenDialog>
      <FullScreenDialog
        open={heldScan !== null}
        title={t("inventory.repack.sourceDate.title")}
        backLabel={t("inventory.work.sourceDate.skip")}
        backPlacement="footer"
        backDisabled={dialogBusy}
        onClose={releaseHeldScan}
        footer={
          heldScan && heldScan.itemCount === 0 ? (
            <Button
              size="floor"
              disabled={dialogBusy}
              onClick={() =>
                void adoptHeldDate().catch((error: unknown) => {
                  console.error("station: repack date adoption failed", error);
                  if (mounted.current) {
                    setWriteFailed(true);
                    releaseHeldScan();
                  }
                })
              }
            >
              {t("inventory.work.sourceDate.apply", {
                date: formatCivilDate(heldScan.codeDate, locale),
              })}
            </Button>
          ) : null
        }
      >
        <div className="inventory-date-dialog inventory-date-dialog--compare">
          <div className="inventory-date-compare">
            <div className="inventory-date-compare__block inventory-date-compare__block--warn">
              <span>{t("inventory.repack.sourceDate.codeLabel")}</span>
              <strong>{heldScan ? formatCivilDate(heldScan.codeDate, locale) : "—"}</strong>
            </div>
            <div className="inventory-date-compare__block">
              <span>{t("inventory.repack.sourceDate.boxLabel")}</span>
              {/* `boxDate` is not carried by the scan outcome (see
                  `HeldRepackScan`), only mirrored from React state via
                  `boxDateRef`, which can still be empty right after a
                  back-to-back old-box + first-bottle scan; fall back instead
                  of formatting an empty string, matching
                  `RepackBoxInstrument`'s own guard on the same field. */}
              <strong>{heldScan?.boxDate ? formatCivilDate(heldScan.boxDate, locale) : "—"}</strong>
            </div>
          </div>
          {heldScan && heldScan.itemCount > 0 ? (
            <>
              <p>{t("inventory.repack.sourceDateBlocked")}</p>
              <Button
                variant="secondary"
                size="floor"
                disabled={dialogBusy}
                onClick={() => {
                  releaseHeldScan();
                  setCorrectionsDialog(true);
                }}
              >
                {t("inventory.repack.corrections")}
              </Button>
            </>
          ) : null}
        </div>
      </FullScreenDialog>
    </StationScreen>
  );
}
