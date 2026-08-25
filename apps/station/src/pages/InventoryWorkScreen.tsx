import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import type { StationInventoryBundleManifest } from "@markiro/domain";

import {
  listRecentInventoryOperations,
  readInventoryProgress,
  reconcilePendingInventoryEvents,
  recordInventoryScan,
  type InventoryProgress,
  type RecentInventoryOperation,
  type RecordInventoryScanResult,
} from "../lib/inventory-journal.js";
import { loadInventoryProductionDate, setInventoryProductionDate } from "../lib/inventory-date.js";
import type { StationClient } from "../lib/api-client.js";
import type { CredentialGeneration } from "../lib/credential-recovery.js";
import { leaveInventoryTask } from "../lib/inventory-sync.js";
import {
  clearOpenInventoryRepackBox,
  changeOpenInventoryRepackDate,
  readInventoryRepackState,
  recordInventoryRepackScan,
  removeLastInventoryRepackItem,
  type InventoryRepackScanResult,
  type InventoryRepackStateView,
} from "../lib/inventory-repacking.js";
import type { SqlExecutor } from "../lib/mirror.js";
import { createScanQueue, type ScanQueue } from "../lib/scan-queue.js";
import type { ScanSource } from "../lib/scan-source.js";
import { useInventorySyncEngine } from "../lib/use-inventory-sync-engine.js";
import { InventoryProgress as InventoryProgressView } from "../ui/inventory/InventoryProgress.js";
import { InventoryScanInstrument } from "../ui/inventory/InventoryScanInstrument.js";
import { RepackBoxInstrument } from "../ui/inventory/RepackBoxInstrument.js";
import { RepackCorrections } from "../ui/inventory/RepackCorrections.js";
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
  createEventId?: () => string;
  now?: () => string;
}

const EMPTY_PROGRESS: InventoryProgress = {
  verified: 0,
  discrepancies: 0,
  protected: 0,
  claimedByDevice: 0,
  acceptedBoxes: 0,
  acceptedItems: 0,
};

const defaultEventId = () => crypto.randomUUID();
const defaultNow = () => new Date().toISOString();

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
}: InventoryWorkScreenProps & {
  inventory: StationInventoryBundleManifest & { mode: "check" };
}) {
  const { t, i18n } = useTranslation();
  const [productionDate, setProductionDate] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState(inventory.productionDateFrom);
  const [dateDialog, setDateDialog] = useState(false);
  const [progress, setProgress] = useState<InventoryProgress>(EMPTY_PROGRESS);
  const [recent, setRecent] = useState<RecentInventoryOperation[]>([]);
  const [result, setResult] = useState<RecordInventoryScanResult | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(false);
  const mounted = useRef(true);
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
    client: client ?? null,
    inventoryId: inventory.inventoryId,
    snapshotId: inventory.snapshotId,
    ...(floorTaskPointerValue ? { floorTaskPointerValue } : {}),
    active: true,
    onProgressApplied: refresh,
    ...(credentialGeneration ? { credentialGeneration } : {}),
  });

  useEffect(() => {
    mounted.current = true;
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
  ]);

  const queue = useMemo(
    () =>
      createScanQueue<RecordInventoryScanResult>({
        process: (raw) =>
          recordInventoryScan(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            taskGtin14: inventory.gtin14,
            raw,
            eventId: createEventId(),
            scannedAt: now(),
          }),
        onOutcome: (outcome) => {
          if (!mounted.current) return;
          setWriteFailed(false);
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
    if (productionDate === null) return undefined;
    queue.open();
    const unregister = onScanQueueRegister?.(queue);
    return () => {
      unregister?.();
      void queue.close();
    };
  }, [onScanQueueRegister, productionDate, queue]);

  useEffect(() => {
    if (productionDate === null || dateDialog) return undefined;
    return source.start((raw) => queue.enqueue(raw));
  }, [dateDialog, productionDate, queue, source]);

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

  const locale = i18n.language === "ru" ? "ru-RU" : "en-US";
  const formattedDate = productionDate
    ? new Intl.DateTimeFormat(locale, { timeZone: "UTC" }).format(
        new Date(`${productionDate}T00:00:00.000Z`),
      )
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
          <strong>{inventory.productName}</strong>
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
            : t("inventory.work.pendingSync", { count: inventorySyncState.pending })}
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
  createEventId = defaultEventId,
  now = defaultNow,
}: InventoryWorkScreenProps & {
  inventory: StationInventoryBundleManifest & { mode: "repack" };
}) {
  const { t, i18n } = useTranslation();
  const [productionDate, setProductionDate] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState(inventory.productionDateFrom);
  const [state, setState] = useState<InventoryRepackStateView>(EMPTY_REPACK_STATE);
  const [result, setResult] = useState<InventoryRepackScanResult | null>(null);
  const [recent, setRecent] = useState<RecentInventoryOperation[]>([]);
  const [writeFailed, setWriteFailed] = useState(false);
  const [dateDialog, setDateDialog] = useState(false);
  const [correctionsDialog, setCorrectionsDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const [nextState, nextRecent] = await Promise.all([
      readInventoryRepackState(exec, inventory.inventoryId, inventory.snapshotId, deviceId),
      listRecentInventoryOperations(exec, inventory.inventoryId, inventory.snapshotId),
    ]);
    if (mounted.current) {
      setState(nextState);
      setRecent(nextRecent);
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
    client: client ?? null,
    inventoryId: inventory.inventoryId,
    snapshotId: inventory.snapshotId,
    ...(floorTaskPointerValue ? { floorTaskPointerValue } : {}),
    active: true,
    onProgressApplied: refresh,
    ...(credentialGeneration ? { credentialGeneration } : {}),
  });

  useEffect(() => {
    mounted.current = true;
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
    if (productionDate === null) return undefined;
    queue.open();
    const unregister = onScanQueueRegister?.(queue);
    return () => {
      unregister?.();
      void queue.close();
    };
  }, [onScanQueueRegister, productionDate, queue]);

  useEffect(() => {
    if (productionDate === null || dateDialog || correctionsDialog) return undefined;
    return source.start((raw) => queue.enqueue(raw));
  }, [correctionsDialog, dateDialog, productionDate, queue, source]);

  const runCorrection = async (kind: "remove" | "clear") => {
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

  const applyDate = async () => {
    if (state.box && state.box.itemCount > 0) return;
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
    ? new Intl.DateTimeFormat(locale, { timeZone: "UTC" }).format(
        new Date(`${productionDate}T00:00:00Z`),
      )
    : t("inventory.work.loadingDate");
  return (
    <StationScreen
      title={t("inventory.repack.title")}
      header={
        <div className="inventory-work-heading">
          <span>{inventory.inventoryNumber}</span>
          <strong>{inventory.productName}</strong>
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
              : t("inventory.work.pendingSync", { count: syncState.pending })}
          </span>
          <Button size="floor" variant="secondary" onClick={() => setDateDialog(true)}>
            {t("inventory.work.change")}
          </Button>
          <Button
            size="floor"
            variant="secondary"
            disabled={!state.box || state.phase !== "scanning"}
            onClick={() => setCorrectionsDialog(true)}
          >
            {t("inventory.repack.corrections")}
          </Button>
          <Button size="floor" variant="secondary" disabled={leaving} onClick={() => void leave()}>
            {leaving ? t("inventory.work.leaving") : t("inventory.work.leave")}
          </Button>
        </div>
        <div className="repack-work-main">
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
              oldSelected: t("inventory.repack.oldSelected"),
              accepted: t("inventory.repack.accepted"),
              discrepancy: t("inventory.repack.discrepancy"),
              writeFailed: t("inventory.work.verdict.writeFailed"),
              position: (position, filled) =>
                t("inventory.repack.position", {
                  position,
                  status: filled ? "занято" : "свободно",
                }),
            }}
          />
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
          busy={busy}
          onRemoveLast={() => void runCorrection("remove")}
          onClear={() => void runCorrection("clear")}
          labels={{
            removeLast: t("inventory.repack.removeLast"),
            clear: t("inventory.repack.clear"),
            empty: t("inventory.repack.empty"),
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
            disabled={Boolean(state.box && state.box.itemCount > 0)}
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
