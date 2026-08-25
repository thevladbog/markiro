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
import type { SqlExecutor } from "../lib/mirror.js";
import { createScanQueue, type ScanQueue } from "../lib/scan-queue.js";
import type { ScanSource } from "../lib/scan-source.js";
import { useInventorySyncEngine } from "../lib/use-inventory-sync-engine.js";
import { InventoryProgress as InventoryProgressView } from "../ui/inventory/InventoryProgress.js";
import { InventoryScanInstrument } from "../ui/inventory/InventoryScanInstrument.js";
import { StationScreen } from "../ui/StationScreen.js";

export interface InventoryWorkScreenProps {
  exec: SqlExecutor;
  inventory: StationInventoryBundleManifest & { mode: "check" };
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

export function InventoryWorkScreen({
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
}: InventoryWorkScreenProps) {
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
  } = useInventorySyncEngine({
    exec,
    client: client ?? null,
    inventoryId: inventory.inventoryId,
    snapshotId: inventory.snapshotId,
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
    const stop = source.start((raw) => queue.enqueue(raw));
    return () => {
      stop();
      unregister?.();
      void queue.close();
    };
  }, [onScanQueueRegister, productionDate, queue, source]);

  useEffect(() => {
    source.setManualTextEntryActive?.(dateDialog);
    return () => source.setManualTextEntryActive?.(false);
  }, [dateDialog, source]);

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
        sync: { nudge: nudgeInventorySync, idle: inventorySyncIdle },
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
                if (mounted.current) setWriteFailed(true);
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
