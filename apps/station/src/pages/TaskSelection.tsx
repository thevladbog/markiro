import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";

import { mirrorInventoryBundle } from "../lib/inventory-bundle.js";
import {
  activateVerifiedInventoryFloorTask,
  clearOwnedInventoryFloorTask,
  parseInventoryTaskList,
  parseResolvedInventoryTask,
  type InventoryFloorTask,
  type ResolvedInventoryTask,
  type StationInventoryTask,
} from "../lib/floor-task.js";
import type { StationClient } from "../lib/api-client.js";
import type { SqlExecutor } from "../lib/mirror.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { ShiftEntryLease } from "../lib/shift-entry-lease.js";
import {
  acquireCredentialCommitLease,
  createFloorCommitLifecycle,
  credentialGenerationOwnership,
  type CredentialGeneration,
  type FloorWorkBarrier,
} from "../lib/credential-recovery.js";
import { parseStationInventoryBundleManifest } from "@markiro/domain";
import { InventoryTaskConfirmation } from "./InventoryTaskConfirmation.js";
import {
  ShiftSelection,
  type ShiftSelectionProps,
  type ShiftSelectionRouteIntent,
  type ShiftSelectionRouteIntentOptions,
} from "./ShiftSelection.js";

const INVENTORY_PAGE_SIZE = 1;
type TaskCategory = "production" | "warehouse";
interface SelectionRouteIntentRecord {
  token: symbol;
  client: StationClient;
  credentialGeneration: CredentialGeneration | undefined;
  lifecycleGeneration: number;
  retirement: Promise<void>;
  state: "pending" | "committed" | "cancelling";
  cancellation: Promise<void> | null;
  allowSealedCredential: boolean;
}

export interface TaskSelectionProps {
  client: StationClient;
  exec: SqlExecutor;
  acquireShiftEntry?: ShiftSelectionProps["acquireShiftEntry"];
  source: ScanSource;
  operatorId: string;
  currentLineName: string | null;
  onShiftSelected: ShiftSelectionProps["onSelected"];
  onInventorySelected: (task: InventoryFloorTask, lease?: ShiftEntryLease) => void;
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
    // null means the task came from an older list response without the field,
    // so only a present-but-different print name counts as a mismatch.
    (task.productPrintName === null || task.productPrintName === manifest.productPrintName) &&
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
  acquireShiftEntry,
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
  const [routePending, setRoutePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState<{
    resolved: ResolvedInventoryTask;
    barcode: string;
  } | null>(null);
  const mounted = useRef(true);
  const lifecycleGeneration = useRef(0);
  const renderedClient = useRef(client);
  const renderedCredentialGeneration = useRef(credentialGeneration);
  const intakeOpen = useRef(true);
  const inventoryOperation = useRef<Promise<void> | null>(null);
  const ownedPointer = useRef<string | null>(null);
  const lifecycleRetirement = useRef<Promise<void> | null>(null);
  const activeRouteIntent = useRef<SelectionRouteIntentRecord | null>(null);
  const commitLifecycle = useMemo(() => createFloorCommitLifecycle(), []);
  const busyRef = useRef(false);
  const routePendingRef = useRef(false);
  const isCurrentRef = useRef(isCurrent);
  const inventoryRequest = useRef<{
    client: StationClient;
    id: number;
    promise: Promise<void>;
  } | null>(null);
  const inventoryRequestId = useRef(0);
  const loadedInventoryClient = useRef<StationClient | null>(null);

  const retireSelectionLifecycle = useCallback((): Promise<void> => {
    intakeOpen.current = false;
    lifecycleGeneration.current += 1;
    if (lifecycleRetirement.current) return lifecycleRetirement.current;
    const operation = inventoryOperation.current ?? Promise.resolve();
    const retirement = Promise.all([operation, commitLifecycle.close()]).then(async () => {
      const pointer = ownedPointer.current;
      if (pointer === null) return;
      await clearOwnedInventoryFloorTask(exec, pointer);
      if (ownedPointer.current === pointer) ownedPointer.current = null;
    });
    lifecycleRetirement.current = retirement;
    return retirement;
  }, [commitLifecycle, exec]);

  useLayoutEffect(() => {
    if (
      renderedClient.current === client &&
      renderedCredentialGeneration.current === credentialGeneration
    )
      return;
    renderedClient.current = client;
    renderedCredentialGeneration.current = credentialGeneration;
    const retirement = retireSelectionLifecycle();
    activeRouteIntent.current = null;
    routePendingRef.current = false;
    inventoryRequestId.current += 1;
    inventoryRequest.current = null;
    loadedInventoryClient.current = null;
    busyRef.current = true;
    setTasks([]);
    setError(null);
    setConfirmation(null);
    setPage(1);
    setLoading(true);
    setBusy(true);
    setRoutePending(false);
    void retirement.then(
      () => {
        if (renderedClient.current !== client || !mounted.current) return;
        lifecycleRetirement.current = null;
        commitLifecycle.open();
        intakeOpen.current = true;
        busyRef.current = false;
        setBusy(false);
      },
      () => {
        if (renderedClient.current === client && mounted.current) {
          setError(t("inventory.joinFailed"));
        }
      },
    );
  }, [client, commitLifecycle, credentialGeneration, retireSelectionLifecycle, t]);

  useEffect(() => {
    isCurrentRef.current = isCurrent;
  }, [isCurrent]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifecycleGeneration.current += 1;
    };
  }, []);

  const floorWorkBarrier = useMemo<FloorWorkBarrier>(
    () => ({
      close() {
        return retireSelectionLifecycle();
      },
      idle() {
        if (lifecycleRetirement.current) return lifecycleRetirement.current;
        const operation = inventoryOperation.current ?? Promise.resolve();
        return Promise.all([operation, commitLifecycle.idle()]).then(() => undefined);
      },
    }),
    [commitLifecycle, retireSelectionLifecycle],
  );

  const acquireRouteIntent = useCallback(
    (options?: ShiftSelectionRouteIntentOptions): ShiftSelectionRouteIntent | null => {
      const allowSealedCredential = options?.allowSealedCredential === true;
      if (
        activeRouteIntent.current !== null ||
        routePendingRef.current ||
        !mounted.current ||
        (!allowSealedCredential && isCurrentRef.current?.() === false)
      )
        return null;

      routePendingRef.current = true;
      busyRef.current = true;
      setRoutePending(true);
      setBusy(true);
      setConfirmation(null);
      const retirement = retireSelectionLifecycle();
      const record: SelectionRouteIntentRecord = {
        token: Symbol("selection-route-intent"),
        client,
        credentialGeneration,
        lifecycleGeneration: lifecycleGeneration.current,
        retirement,
        state: "pending",
        cancellation: null,
        allowSealedCredential,
      };
      activeRouteIntent.current = record;

      return {
        ready: retirement,
        commit() {
          if (
            activeRouteIntent.current?.token !== record.token ||
            record.state !== "pending" ||
            !mounted.current ||
            renderedClient.current !== record.client ||
            renderedCredentialGeneration.current !== record.credentialGeneration ||
            lifecycleGeneration.current !== record.lifecycleGeneration ||
            (!record.allowSealedCredential && isCurrentRef.current?.() === false)
          )
            return false;
          activeRouteIntent.current.state = "committed";
          return true;
        },
        cancel() {
          if (record.state === "committed") return Promise.resolve();
          if (record.cancellation) return record.cancellation;
          if (activeRouteIntent.current?.token === record.token) {
            activeRouteIntent.current.state = "cancelling";
          }
          record.cancellation = retirement.then(() => {
            if (
              activeRouteIntent.current?.token !== record.token ||
              !mounted.current ||
              renderedClient.current !== record.client ||
              renderedCredentialGeneration.current !== record.credentialGeneration ||
              lifecycleGeneration.current !== record.lifecycleGeneration ||
              isCurrentRef.current?.() === false
            )
              return;
            if (lifecycleRetirement.current === retirement) lifecycleRetirement.current = null;
            commitLifecycle.open();
            intakeOpen.current = true;
            activeRouteIntent.current = null;
            routePendingRef.current = false;
            busyRef.current = false;
            setRoutePending(false);
            setBusy(false);
          });
          return record.cancellation;
        },
      };
    },
    [client, commitLifecycle, credentialGeneration, retireSelectionLifecycle],
  );

  useEffect(() => {
    const priorRetirement = lifecycleRetirement.current;
    if (priorRetirement === null) {
      commitLifecycle.open();
    } else {
      void priorRetirement.then(
        () => {
          if (!mounted.current) return;
          if (activeRouteIntent.current !== null) return;
          lifecycleRetirement.current = null;
          commitLifecycle.open();
          intakeOpen.current = true;
        },
        (error: unknown) => {
          console.error("station: inventory selection retirement failed", error);
        },
      );
    }
    const unregister = onFloorWorkRegister?.(floorWorkBarrier);
    return () => {
      void (floorWorkBarrier.close?.() ?? floorWorkBarrier.idle())
        .catch((error: unknown) => {
          console.error("station: inventory selection retirement failed", error);
        })
        .finally(() => unregister?.());
    };
  }, [commitLifecycle, floorWorkBarrier, onFloorWorkRegister]);

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
      const activationId = crypto.randomUUID();
      let shiftEntryLease: ShiftEntryLease | null = null;
      const lease = {
        isCurrent: () =>
          mounted.current &&
          lifecycleGeneration.current === originGeneration &&
          isCurrentRef.current?.() !== false &&
          (shiftEntryLease?.isCurrent() ?? true),
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
        const credentialOwnership = credentialGeneration
          ? await credentialGenerationOwnership(credentialGeneration)
          : null;
        if (!lease.isCurrent() || (credentialGeneration && credentialOwnership === null)) return;
        let active: InventoryFloorTask | null = null;
        const published = await mirrorInventoryBundle(client, exec, task.inventoryId, {
          ...lease,
          ...(credentialOwnership ? { credentialOwnership } : {}),
          commitPublication: async (publishSnapshot) => {
            if (!lease.isCurrent()) return false;
            const floorCommitLease = commitLifecycle.acquire();
            if (!floorCommitLease) return false;
            const credentialCommitLease = credentialGeneration
              ? acquireCredentialCommitLease(credentialGeneration)
              : null;
            if (credentialGeneration && !credentialCommitLease) {
              floorCommitLease.release();
              return false;
            }
            try {
              if (!(await publishSnapshot())) return false;
              active = await activateVerifiedInventoryFloorTask(exec, task.inventoryId, {
                ...(credentialCommitLease ? { credentialLease: credentialCommitLease } : {}),
                activationId,
                onPointerCommitted: (pointer) => {
                  ownedPointer.current = pointer;
                },
              });
              return true;
            } finally {
              credentialCommitLease?.release();
              floorCommitLease.release();
            }
          },
        });
        if (!published || !lease.isCurrent()) return;
        // Keep bundle publication retireable from the task selector. The updater
        // lease is only needed when the verified local task is handed to App.
        if (acquireShiftEntry) {
          try {
            shiftEntryLease = await acquireShiftEntry();
          } catch (error) {
            const pointer = ownedPointer.current;
            if (pointer !== null) {
              await clearOwnedInventoryFloorTask(exec, pointer);
              if (ownedPointer.current === pointer) ownedPointer.current = null;
            }
            throw error;
          }
          if (!lease.isCurrent()) return;
        }
        if (!active) throw new Error("inventory floor task activation unavailable");
        if (!lease.isCurrent()) return;
        if (mounted.current) {
          setConfirmation(null);
          const transferredPointer = ownedPointer.current;
          ownedPointer.current = null;
          try {
            if (shiftEntryLease) onInventorySelected(active, shiftEntryLease);
            else onInventorySelected(active);
          } catch (error) {
            ownedPointer.current = transferredPointer;
            throw error;
          }
        }
      } catch {
        if (
          mounted.current &&
          lifecycleGeneration.current === originGeneration &&
          isCurrentRef.current?.() !== false
        )
          setError(t("inventory.joinFailed"));
      } finally {
        shiftEntryLease?.release();
        if (lifecycleGeneration.current === originGeneration) {
          busyRef.current = false;
          if (mounted.current && isCurrentRef.current?.() !== false) setBusy(false);
        }
      }
    },
    [
      acquireShiftEntry,
      client,
      commitLifecycle,
      credentialGeneration,
      exec,
      onInventorySelected,
      operatorId,
      t,
    ],
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
                <span>{task.productPrintName ?? task.productName}</span>
                <small>
                  {t(task.mode === "repack" ? "inventory.modeRepack" : "inventory.modeCheck")}
                </small>
              </div>
              <Button
                size="floor"
                disabled={busy || routePending}
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
        {...(acquireShiftEntry ? { acquireShiftEntry } : {})}
        onSelected={onShiftSelected}
        onNew={onNew}
        {...(onSetup ? { onSetup } : {})}
        {...(onConflicts ? { onConflicts } : {})}
        {...(isCurrent ? { isCurrent } : {})}
        onRouteIntent={acquireRouteIntent}
        routeControlsDisabled={routePending}
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
              disabled={routePending}
              onClick={() => setCategory("production")}
            >
              {t("inventory.categories.production", { count: openShiftCount })}
            </Button>
            <Button
              size="floor"
              variant={category === "warehouse" ? "primary" : "secondary"}
              role="tab"
              aria-selected={category === "warehouse"}
              disabled={routePending}
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
