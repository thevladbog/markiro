import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import {
  acquireCredentialCommitLease,
  type CredentialGeneration,
  type FloorWorkBarrier,
} from "../lib/credential-recovery.js";
import { parseStationInventoryBundleManifest } from "@markiro/domain";
import { InventoryTaskConfirmation } from "./InventoryTaskConfirmation.js";
import { ShiftSelection, type ShiftSelectionProps } from "./ShiftSelection.js";

const INVENTORY_PAGE_SIZE = 1;
type TaskCategory = "production" | "warehouse";

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
  credentialGeneration?: CredentialGeneration;
  onFloorWorkRegister?: (barrier: FloorWorkBarrier) => () => void;
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
  credentialGeneration,
  onFloorWorkRegister,
}: TaskSelectionProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<TaskCategory>("production");
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
  const lifecycleGeneration = useRef(0);
  const renderedClient = useRef(client);
  const intakeOpen = useRef(true);
  const floorRetirementClosing = useRef(false);
  const inventoryOperation = useRef<Promise<void> | null>(null);
  const busyRef = useRef(false);
  const isCurrentRef = useRef(isCurrent);
  const inventoryRequest = useRef<{
    client: StationClient;
    id: number;
    promise: Promise<void>;
  } | null>(null);
  const inventoryRequestId = useRef(0);
  const loadedInventoryClient = useRef<StationClient | null>(null);

  useLayoutEffect(() => {
    if (renderedClient.current === client) return;
    renderedClient.current = client;
    lifecycleGeneration.current += 1;
    intakeOpen.current = true;
    floorRetirementClosing.current = false;
    inventoryRequestId.current += 1;
    inventoryRequest.current = null;
    loadedInventoryClient.current = null;
    busyRef.current = false;
    setTasks([]);
    setError(null);
    setConfirmation(null);
    setPage(1);
    setLoading(true);
    setBusy(false);
  }, [client]);

  useEffect(() => {
    isCurrentRef.current = isCurrent;
  }, [isCurrent]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!floorRetirementClosing.current) lifecycleGeneration.current += 1;
    };
  }, []);

  const retireSelectionAttempts = useCallback(() => {
    intakeOpen.current = false;
    lifecycleGeneration.current += 1;
  }, []);

  const floorWorkBarrier = useMemo<FloorWorkBarrier>(
    () => ({
      close() {
        intakeOpen.current = false;
        floorRetirementClosing.current = true;
        return inventoryOperation.current ?? Promise.resolve();
      },
      idle() {
        return inventoryOperation.current ?? Promise.resolve();
      },
    }),
    [],
  );

  useEffect(() => onFloorWorkRegister?.(floorWorkBarrier), [floorWorkBarrier, onFloorWorkRegister]);

  const refreshInventoryTasks = useCallback((): Promise<void> => {
    if (inventoryRequest.current?.client === client) return inventoryRequest.current.promise;
    const id = ++inventoryRequestId.current;
    const initialForClient = loadedInventoryClient.current !== client;
    if (initialForClient) setLoading(true);
    setError(null);
    const promise = client
      .get<unknown>("/station/inventory-tasks")
      .then((value) => {
        if (
          !mounted.current ||
          inventoryRequest.current?.id !== id ||
          isCurrentRef.current?.() === false
        )
          return;
        setTasks(parseInventoryTaskList(value));
        loadedInventoryClient.current = client;
      })
      .catch(() => {
        if (
          !mounted.current ||
          inventoryRequest.current?.id !== id ||
          isCurrentRef.current?.() === false
        )
          return;
        setError(t("inventory.loadFailed"));
      })
      .finally(() => {
        if (inventoryRequest.current?.id !== id) return;
        inventoryRequest.current = null;
        if (mounted.current && isCurrentRef.current?.() !== false) setLoading(false);
      });
    inventoryRequest.current = { client, id, promise };
    return promise;
  }, [client, t]);

  const performJoinTask = useCallback(
    async (task: StationInventoryTask, barcode?: string, confirmDifferentLine?: true) => {
      if (!intakeOpen.current || busyRef.current || isCurrentRef.current?.() === false) return;
      const originGeneration = lifecycleGeneration.current;
      const lease = {
        isCurrent: () =>
          (mounted.current || floorRetirementClosing.current) &&
          lifecycleGeneration.current === originGeneration &&
          isCurrentRef.current?.() !== false,
      };
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
        if (!lease.isCurrent()) return;
        if (!taskMatchesManifest(task, joined)) throw new Error("inventory join task mismatch");
        let active: InventoryFloorTask | null = null;
        const published = await mirrorInventoryBundle(client, exec, task.inventoryId, {
          ...lease,
          commitPublication: async (publishSnapshot) => {
            if (!lease.isCurrent()) return false;
            if (!credentialGeneration) return publishSnapshot();
            const commitLease = acquireCredentialCommitLease(credentialGeneration);
            if (!commitLease) return false;
            try {
              if (!lease.isCurrent()) return false;
              if (!(await publishSnapshot()) || !lease.isCurrent()) return false;
              active = await activateVerifiedInventoryFloorTask(
                exec,
                task.inventoryId,
                commitLease,
              );
              return true;
            } finally {
              commitLease.release();
            }
          },
        });
        if (!published || !lease.isCurrent()) return;
        if (!credentialGeneration) {
          active = await activateVerifiedInventoryFloorTask(exec, task.inventoryId);
        }
        if (!active) throw new Error("inventory floor task activation unavailable");
        if (!lease.isCurrent()) return;
        if (mounted.current) {
          setConfirmation(null);
          onInventorySelected(active);
        }
      } catch {
        if (
          mounted.current &&
          lifecycleGeneration.current === originGeneration &&
          isCurrentRef.current?.() !== false
        )
          setError(t("inventory.joinFailed"));
      } finally {
        if (lifecycleGeneration.current === originGeneration) {
          busyRef.current = false;
          if (mounted.current && isCurrentRef.current?.() !== false) setBusy(false);
        }
      }
    },
    [client, credentialGeneration, exec, onInventorySelected, operatorId, t],
  );

  const joinTask = useCallback(
    (task: StationInventoryTask, barcode?: string, confirmDifferentLine?: true): Promise<void> => {
      if (inventoryOperation.current) return inventoryOperation.current;
      const operation = performJoinTask(task, barcode, confirmDifferentLine);
      inventoryOperation.current = operation;
      void operation.finally(() => {
        if (inventoryOperation.current === operation) inventoryOperation.current = null;
      });
      return operation;
    },
    [performJoinTask],
  );

  useEffect(() => {
    return source.start((barcode) => {
      if (!intakeOpen.current || busyRef.current || isCurrentRef.current?.() === false) return;
      const originGeneration = lifecycleGeneration.current;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      void (async () => {
        let handedToJoin = false;
        try {
          const resolved = parseResolvedInventoryTask(
            await client.post<unknown>("/station/inventory-tasks/resolve-barcode", { barcode }),
          );
          if (
            !mounted.current ||
            lifecycleGeneration.current !== originGeneration ||
            isCurrentRef.current?.() === false
          )
            return;
          if (resolved.requiresDifferentLineConfirmation) {
            setConfirmation({ resolved, barcode });
            return;
          }
          busyRef.current = false;
          setBusy(false);
          handedToJoin = true;
          await joinTask(resolved.task, barcode);
        } catch {
          if (
            mounted.current &&
            lifecycleGeneration.current === originGeneration &&
            isCurrentRef.current?.() !== false
          )
            setError(t("inventory.barcodeFailed"));
        } finally {
          if (!handedToJoin && lifecycleGeneration.current === originGeneration) {
            busyRef.current = false;
            if (
              mounted.current &&
              lifecycleGeneration.current === originGeneration &&
              isCurrentRef.current?.() !== false
            )
              setBusy(false);
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
        onRouteIntent={retireSelectionAttempts}
        onCoordinatedRefresh={refreshInventoryTasks}
        title={category === "warehouse" ? t("inventory.warehouseTitle") : t("shifts.title")}
        actionsLabel={category === "warehouse" ? t("inventory.actions") : t("shifts.actions")}
        refreshLabel={category === "warehouse" ? t("inventory.refresh") : t("shifts.refresh")}
        productionActionsVisible={category === "production"}
        alternateActive={category === "warehouse"}
        alternateContent={inventoryPanel}
        categoryNavigation={(openShiftCount) => (
          <div
            className="floor-task-categories"
            role="tablist"
            aria-label={t("inventory.categories.label")}
          >
            <Button
              size="floor"
              variant={category === "production" ? "primary" : "secondary"}
              role="tab"
              aria-selected={category === "production"}
              onClick={() => setCategory("production")}
            >
              {t("inventory.categories.production", { count: openShiftCount })}
            </Button>
            <Button
              size="floor"
              variant={category === "warehouse" ? "primary" : "secondary"}
              role="tab"
              aria-selected={category === "warehouse"}
              onClick={() => setCategory("warehouse")}
            >
              {t("inventory.categories.warehouse", { count: tasks.length })}
            </Button>
          </div>
        )}
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
