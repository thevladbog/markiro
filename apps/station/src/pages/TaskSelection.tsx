import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";

import { mirrorInventoryBundle } from "../lib/inventory-bundle.js";
import {
  activateVerifiedInventoryFloorTask,
  parseInventoryTaskList,
  parseResolvedInventoryTask,
  type InventoryFloorTask,
  type ResolvedInventoryTask,
  type StationInventoryTask,
} from "../lib/floor-task.js";
import type { StationClient } from "../lib/api-client.js";
import type { SqlExecutor } from "../lib/mirror.js";
import type { ScanSource } from "../lib/scan-source.js";
import { parseStationInventoryBundleManifest } from "@markiro/domain";
import { InventoryTaskConfirmation } from "./InventoryTaskConfirmation.js";
import { ShiftSelection, type ShiftSelectionProps } from "./ShiftSelection.js";

const INVENTORY_PAGE_SIZE = 1;

export interface TaskSelectionProps {
  client: StationClient;
  exec: SqlExecutor;
  source: ScanSource;
  operatorId: string;
  currentLineName: string | null;
  onShiftSelected: ShiftSelectionProps["onSelected"];
  onInventorySelected: (task: InventoryFloorTask) => void;
  onNew: () => void;
  onSetup?: () => void;
  onConflicts?: () => void;
  isCurrent?: () => boolean;
}

function taskMatchesManifest(
  task: StationInventoryTask,
  manifest: ReturnType<typeof parseStationInventoryBundleManifest>,
): boolean {
  return (
    task.inventoryId === manifest.inventoryId &&
    task.inventoryNumber === manifest.inventoryNumber &&
    task.productName === manifest.productName &&
    task.mode === manifest.mode &&
    task.lineId === manifest.lineId &&
    task.lineName === manifest.lineName &&
    task.productionDateFrom === manifest.productionDateFrom &&
    task.productionDateTo === manifest.productionDateTo
  );
}

export function TaskSelection({
  client,
  exec,
  source,
  operatorId,
  currentLineName,
  onShiftSelected,
  onInventorySelected,
  onNew,
  onSetup,
  onConflicts,
  isCurrent,
}: TaskSelectionProps) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<StationInventoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState<{
    resolved: ResolvedInventoryTask;
    barcode: string;
  } | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const isCurrentRef = useRef(isCurrent);

  useEffect(() => {
    isCurrentRef.current = isCurrent;
  }, [isCurrent]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshInventoryTasks = useCallback(() => {
    setLoading(true);
    setError(null);
    void client
      .get<unknown>("/station/inventory-tasks")
      .then((value) => {
        if (!mounted.current || isCurrentRef.current?.() === false) return;
        setTasks(parseInventoryTaskList(value));
      })
      .catch(() => {
        if (!mounted.current || isCurrentRef.current?.() === false) return;
        setError(t("inventory.loadFailed"));
      })
      .finally(() => {
        if (mounted.current && isCurrentRef.current?.() !== false) setLoading(false);
      });
  }, [client, t]);

  useEffect(() => {
    refreshInventoryTasks();
  }, [refreshInventoryTasks]);

  const joinTask = useCallback(
    async (task: StationInventoryTask, barcode?: string, confirmDifferentLine?: true) => {
      if (busyRef.current || isCurrentRef.current?.() === false) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const body = {
          operatorId,
          ...(barcode === undefined ? {} : { barcode }),
          ...(confirmDifferentLine === undefined ? {} : { confirmDifferentLine }),
        };
        const joined = parseStationInventoryBundleManifest(
          await client.post<unknown>(`/station/inventories/${task.inventoryId}/join`, body),
        );
        if (!taskMatchesManifest(task, joined)) throw new Error("inventory join task mismatch");
        const published = await mirrorInventoryBundle(client, exec, task.inventoryId);
        if (!published) throw new Error("inventory bundle publication was superseded");
        const active = await activateVerifiedInventoryFloorTask(exec, task.inventoryId);
        if (!mounted.current || isCurrentRef.current?.() === false) return;
        setConfirmation(null);
        onInventorySelected(active);
      } catch {
        if (mounted.current && isCurrentRef.current?.() !== false)
          setError(t("inventory.joinFailed"));
      } finally {
        busyRef.current = false;
        if (mounted.current && isCurrentRef.current?.() !== false) setBusy(false);
      }
    },
    [client, exec, onInventorySelected, operatorId, t],
  );

  useEffect(() => {
    return source.start((barcode) => {
      if (busyRef.current || isCurrentRef.current?.() === false) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      void (async () => {
        let handedToJoin = false;
        try {
          const resolved = parseResolvedInventoryTask(
            await client.post<unknown>("/station/inventory-tasks/resolve-barcode", { barcode }),
          );
          if (!mounted.current || isCurrentRef.current?.() === false) return;
          if (resolved.requiresDifferentLineConfirmation) {
            setConfirmation({ resolved, barcode });
            return;
          }
          busyRef.current = false;
          setBusy(false);
          handedToJoin = true;
          await joinTask(resolved.task, barcode);
        } catch {
          if (mounted.current && isCurrentRef.current?.() !== false)
            setError(t("inventory.barcodeFailed"));
        } finally {
          if (!handedToJoin) {
            busyRef.current = false;
            if (mounted.current && isCurrentRef.current?.() !== false) setBusy(false);
          }
        }
      })();
    });
  }, [client, joinTask, source, t]);

  const pageCount = Math.max(1, Math.ceil(tasks.length / INVENTORY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleTasks = useMemo(
    () => tasks.slice((currentPage - 1) * INVENTORY_PAGE_SIZE, currentPage * INVENTORY_PAGE_SIZE),
    [currentPage, tasks],
  );

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);

  const inventoryPanel = (
    <section className="inventory-task-selection" aria-labelledby="inventory-task-selection-title">
      <div className="inventory-task-selection__scan">
        <span className="inventory-task-selection__scan-mark" aria-hidden="true" />
        <div>
          <h2 id="inventory-task-selection-title">{t("inventory.scanTitle")}</h2>
          <p>{t("inventory.scanHint")}</p>
        </div>
        <strong>{t("inventory.taskBarcode")}</strong>
      </div>
      <div className="inventory-task-selection__heading">
        <h3>{t("inventory.assignedTitle", { line: currentLineName ?? "—" })}</h3>
        <span>{t("inventory.taskCount", { count: tasks.length })}</span>
      </div>
      <div className="inventory-task-selection__body">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {loading ? (
          <p role="status">{t("inventory.loading")}</p>
        ) : visibleTasks.length === 0 ? (
          <p>{t("inventory.empty")}</p>
        ) : (
          visibleTasks.map((task) => (
            <article className="inventory-task-card" key={task.inventoryId}>
              <div>
                <strong>{task.inventoryNumber}</strong>
                <span>{task.productName}</span>
                <small>
                  {t(task.mode === "repack" ? "inventory.modeRepack" : "inventory.modeCheck")}
                </small>
              </div>
              <Button
                size="floor"
                disabled={busy}
                aria-label={t("inventory.continueLabel", { number: task.inventoryNumber })}
                onClick={() => void joinTask(task)}
              >
                {t("inventory.continue")}
              </Button>
            </article>
          ))
        )}
        {pageCount > 1 ? (
          <div className="inventory-task-selection__pager" aria-label={t("inventory.pagination")}>
            <Button
              size="floor"
              variant="secondary"
              disabled={currentPage === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              {t("inventory.previous")}
            </Button>
            <span>{t("inventory.page", { page: currentPage, pageCount })}</span>
            <Button
              size="floor"
              variant="secondary"
              disabled={currentPage === pageCount}
              onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            >
              {t("inventory.next")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );

  return (
    <>
      <ShiftSelection
        client={client}
        exec={exec}
        onSelected={onShiftSelected}
        onNew={onNew}
        {...(onSetup ? { onSetup } : {})}
        {...(onConflicts ? { onConflicts } : {})}
        {...(isCurrent ? { isCurrent } : {})}
        {...(tasks.length > 0 ? { title: t("inventory.warehouseTitle") } : {})}
        beforeList={inventoryPanel}
      />
      {confirmation ? (
        <InventoryTaskConfirmation
          resolved={confirmation.resolved}
          currentLineName={currentLineName}
          busy={busy}
          onCancel={() => {
            if (busy) return;
            setConfirmation(null);
          }}
          onConfirm={() => void joinTask(confirmation.resolved.task, confirmation.barcode, true)}
        />
      ) : null}
    </>
  );
}
