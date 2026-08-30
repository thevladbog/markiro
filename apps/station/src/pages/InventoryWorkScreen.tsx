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
  const [progress, setProgress] = useState<InventoryProgress>(gallery?.progress ?? EMPTY_PROGRESS);
  const [recent, setRecent] = useState<RecentInventoryOperation[]>(gallery?.recent ?? []);
  const [result, setResult] = useState<RecordInventoryScanResult | null>(gallery?.result ?? null);
  const [writeFailed, setWriteFailed] = useState(gallery?.writeFailed ?? false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(gallery?.leaveFailed ?? false);
  const mounted = useRef(true);
  const [heldScan, setHeldScan] = useState<HeldInventoryScan | null>(gallery?.heldScan ?? null);
  const heldRef = useRef(false);
  const heldScanRef = useRef<HeldInventoryScan | null>(gallery?.heldScan ?? null);
  useEffect(() => {
    heldScanRef.current = heldScan;
  }, [heldScan]);
  const [dialogBusy, setDialogBusy] = useState(false);
  const dialogBusyRef = useRef(false);
  const bypassRef = useRef<string | null>(null);
  const queueRef = useRef<ScanQueue | null>(null);
  const refresh = useCallback(async () => {
    const [nextProgress, nextRecent] = await Promise.all([
      readInventoryProgress(exec, inventory.inventoryId, inventory.snapshotId, deviceId),
      listRecentInventoryOperations(exec, inventory.inventoryId, inventory.snapshotId),
    ]);
    if (mounted.current) {
      setProgress(nextProgress);
      setRecent(nextRecent);
      setResult((current) => current ?? (nextRecent[0] ? restoredResult(nextRecent[0]) : null));
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
    await new Promise<void>((resolve, reject) => {
      const accepted = queue.enqueueJob(async () => {
        try {
          await setInventoryProductionDate(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            productionDate: dateDraft,
            updatedAt: now(),
          });
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("inventory date update failed"));
          throw error;
        }
      });
      if (!accepted) reject(new Error("inventory scan queue is closed"));
    });
    if (mounted.current) {
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
    new Promise<void>((resolve, reject) => {
      const accepted = queue.enqueueJob(async () => {
        try {
          await setInventoryProductionDate(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            productionDate,
            updatedAt: now(),
          });
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("inventory date update failed"));
          throw error;
        }
      });
      if (!accepted) reject(new Error("inventory scan queue is closed"));
    });

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
      if (heldScanRef.current !== held) {
        // Defensive guard only: the dialog's skip control (and its Escape
        // path, gated by the same `backDisabled` flag inside
        // `FullScreenDialog`) stays disabled for this write's entire
        // duration, so nothing can change `heldScan` out from under this
        // call while it is in flight — this branch should be unreachable.
        // If it nonetheless fires, decline to resurrect the held scan: do
        // not enqueue it, and do not write anything back. There is no
        // longer any prior state a compensating write would need to
        // restore, since the overlap it used to compensate for cannot occur.
        return;
      }
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
        <div className="inventory-date-dialog">
          <p>
            {heldScan?.mixed
              ? t("inventory.work.sourceDate.mixedBody", {
                  active: heldScan ? formatCivilDate(heldScan.activeDate, locale) : "",
                })
              : t("inventory.work.sourceDate.body", {
                  code: heldScan?.codeDate ? formatCivilDate(heldScan.codeDate, locale) : "",
                  active: heldScan ? formatCivilDate(heldScan.activeDate, locale) : "",
                })}
          </p>
          {!heldScan?.mixed && !codeDateInRange ? (
            <p>{t("inventory.work.sourceDate.outOfRange")}</p>
          ) : null}
        </div>
      </FullScreenDialog>
    </StationScreen>
  );
}

const EMPTY_REPACK_STATE: InventoryRepackStateView = { phase: "awaiting-old-box", box: null };

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
      createScanQueue<InventoryRepackScanResult>({
        process: (raw) =>
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
          }),
        onOutcome: (outcome) => {
          if (!mounted.current) return;
          if (outcome.verdict === "old-box-selected") {
            setPrintResult(null);
            setProvisionalPrintFailure(null);
          }
          if (outcome.verdict === "capacity-closed") setPrintBusy(true);
          setResult(outcome);
          setWriteFailed(false);
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
      printBusy
    ) {
      return undefined;
    }
    return source.start((raw) => queue.enqueue(raw));
  }, [
    correctionsDialog,
    dateDialog,
    gallery,
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
      await new Promise<void>((resolve, reject) => {
        if (
          !queue.enqueueJob(async () => {
            try {
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
              resolve();
            } catch (error) {
              reject(error instanceof Error ? error : new Error("repack correction failed"));
              throw error;
            }
          })
        ) {
          reject(new Error("inventory scan queue is closed"));
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
    await new Promise<void>((resolve, reject) => {
      if (
        !queue.enqueueJob(async () => {
          try {
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
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error("repack date change failed"));
            throw error;
          }
        })
      ) {
        reject(new Error("inventory scan queue is closed"));
      }
    });
    await refresh();
    if (mounted.current) {
      setProductionDate(dateDraft);
      setDateDialog(false);
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
    </StationScreen>
  );
}
