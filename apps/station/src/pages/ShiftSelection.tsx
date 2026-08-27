import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Pager } from "@markiro/ui";
import { StationApiError, type StationClient } from "../lib/api-client.js";
import { paginate } from "../lib/pagination.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { ShiftCard } from "../ui/ShiftCard.js";
import type { SqlExecutor } from "../lib/mirror.js";
import type { AcquireShiftEntry, ShiftEntryLease } from "../lib/shift-entry-lease.js";
import { StationScreen } from "../ui/StationScreen.js";
import {
  prefetchStationProductImage,
  trackStationProductImageSync,
} from "../lib/product-image-cache.js";

/** Two large choices stay legible on the 1280×800 line-terminal baseline. */
const SHIFT_PAGE_SIZE = 2;
const SHIFT_REFRESH_MS = 30_000;

interface ShiftListItem {
  id: string;
  number?: string | null;
  status: "planned" | "active" | "closed";
  mode: "validation" | "aggregation";
  productName: string | null;
  /** Short operator-facing name from the catalog; null = use productName. */
  productPrintName?: string | null;
  plannedQty: number | null;
  plannedDate: string | null;
  productionDate?: string | null;
  counterpartyName?: string | null;
  productId: string;
  image?: {
    checksum: string;
    contentType: "image/webp";
    byteSize: number;
    width: number;
    height: number;
  } | null;
}

async function excludeLocallyClosedShifts(
  exec: SqlExecutor | undefined,
  items: ShiftListItem[],
): Promise<ShiftListItem[]> {
  if (!exec || items.length === 0) return items;
  const placeholders = items.map(() => "?").join(", ");
  const rows = await exec.all<{ id: string }>(
    `SELECT shift_id AS id FROM shift_close_outbox WHERE shift_id IN (${placeholders})`,
    items.map((shift) => shift.id),
  );
  if (rows.length === 0) return items;
  const closedIds = new Set(rows.map((row) => row.id));
  return items.filter((shift) => !closedIds.has(shift.id));
}

export interface ShiftSelectionProps {
  client: StationClient;
  exec?: SqlExecutor;
  acquireShiftEntry?: AcquireShiftEntry;
  onSelected: (
    shift: { id: string; status: string; mode: string },
    lease?: ShiftEntryLease,
  ) => void | Promise<void>;
  onNew: () => void;
  /** Opens the workstation setup screen; omitted where there is no way in. */
  onSetup?: () => void;
  /** Opens the conflict list; omitted where there is no way in. */
  onConflicts?: () => void;
  /** False once this credential generation is sealed or this floor is retired. */
  isCurrent?: () => boolean;
  /** Exclusively retires selection work before another route starts. */
  onRouteIntent?: (options?: ShiftSelectionRouteIntentOptions) => ShiftSelectionRouteIntent | null;
  /** Disables route controls owned by the wider floor-task selection surface. */
  routeControlsDisabled?: boolean;
  /** Runs under the same initial/manual/poll request lock as the shift list. */
  onCoordinatedRefresh?: () => Promise<void>;
  /** Header-row action (top right); receives the current visible production count. */
  headerAction?: (openShiftCount: number) => ReactNode;
  alternateContent?: ReactNode;
  alternateActive?: boolean;
  productionActionsVisible?: boolean;
  title?: string;
  actionsLabel?: string;
  refreshLabel?: string;
}

export interface ShiftSelectionRouteIntent {
  ready: Promise<void>;
  commit: () => boolean;
  cancel: () => Promise<void>;
}

export interface ShiftSelectionRouteIntentOptions {
  /** Setup remains reachable for legacy repair after production credentials are sealed. */
  allowSealedCredential?: true;
}

export type ShiftSelectionPersistentState =
  "loading" | "read-error" | "empty" | "page-1" | "page-2";

export function shiftSelectionPersistentState(input: {
  loading: boolean;
  loadFailed: boolean;
  openItemCount: number;
  page: number;
}): ShiftSelectionPersistentState {
  if (input.loading) return "loading";
  if (input.loadFailed) return "read-error";
  if (input.openItemCount === 0) return "empty";
  return input.page <= 1 ? "page-1" : "page-2";
}

export function ShiftSelection({
  client,
  exec,
  acquireShiftEntry,
  onSelected,
  onNew,
  onSetup,
  onConflicts,
  isCurrent,
  onRouteIntent,
  routeControlsDisabled = false,
  onCoordinatedRefresh,
  headerAction,
  alternateContent,
  alternateActive = false,
  productionActionsVisible = true,
  title,
  actionsLabel,
  refreshLabel,
}: ShiftSelectionProps) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<ShiftListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  /**
   * Only operator-initiated refreshes gate the control. The 30 s poll used to
   * drive it too, so the empty screen blinked its button every interval tick.
   */
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageRefreshKey, setImageRefreshKey] = useState(0);
  const [requestedPage, setRequestedPage] = useState(1);
  const mounted = useRef(true);
  const shiftEntryOperation = useRef(0);
  const isCurrentRef = useRef(isCurrent);
  const listRequest = useRef<{ client: StationClient; id: number } | null>(null);
  const listRequestId = useRef(0);
  const loadedClient = useRef<StationClient | null>(null);

  useEffect(() => {
    isCurrentRef.current = isCurrent;
  }, [isCurrent]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      shiftEntryOperation.current += 1;
    };
  }, []);

  const refreshShifts = useCallback(
    (options?: { manual?: boolean }) => {
      const manual = options?.manual === true;
      if (listRequest.current?.client === client) {
        // A press during a background poll folds into it rather than being
        // dropped silently, so the control still reflects the operator's ask.
        if (manual) setManualRefreshing(true);
        return;
      }

      const id = ++listRequestId.current;
      listRequest.current = { client, id };
      const initialForClient = loadedClient.current !== client;
      if (initialForClient) setLoading(true);
      if (manual) setManualRefreshing(true);
      setLoadFailed(false);
      setError(null);
      const shiftRequest = client
        .get<{ items: ShiftListItem[] }>("/shifts")
        .then(async (response) => {
          let visibleItems = response.items;
          try {
            visibleItems = await excludeLocallyClosedShifts(exec, response.items);
          } catch (err) {
            console.error("station: locally closed shift reconciliation failed", err);
          }
          if (!mounted.current || listRequest.current?.id !== id) return;
          setItems(visibleItems);
          loadedClient.current = client;
          for (const shift of visibleItems) {
            const currentCheck = isCurrentRef.current;
            const prefetch = prefetchStationProductImage(
              client,
              {
                id: shift.productId,
                ...(shift.image === undefined ? {} : { image: shift.image }),
              },
              currentCheck ? () => !currentCheck() : undefined,
              exec,
            );
            trackStationProductImageSync(prefetch);
            void prefetch.then(() => {
              if (mounted.current) setImageRefreshKey((key) => key + 1);
            });
          }
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!mounted.current || listRequest.current?.id !== id) return;
          setError(err instanceof StationApiError ? err.message : t("shifts.serverUnavailable"));
          if (initialForClient) {
            setLoadFailed(true);
            setLoading(false);
          }
        });
      const coordinatedRequest = Promise.resolve()
        .then(() => onCoordinatedRefresh?.())
        .catch((err: unknown) => {
          console.error("station: coordinated floor-task refresh failed", err);
        });
      void Promise.all([shiftRequest, coordinatedRequest]).finally(() => {
        if (!mounted.current || listRequest.current?.id !== id) return;
        listRequest.current = null;
        setManualRefreshing(false);
      });
    },
    [client, exec, onCoordinatedRefresh, t],
  );

  useEffect(() => {
    refreshShifts();
  }, [refreshShifts]);

  useEffect(() => {
    const refresh = window.setInterval(() => {
      refreshShifts();
    }, SHIFT_REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [refreshShifts]);

  const openItems = useMemo(() => items.filter((shift) => shift.status !== "closed"), [items]);
  const currentPage = paginate(openItems, requestedPage, SHIFT_PAGE_SIZE);
  const persistentState = shiftSelectionPersistentState({
    loading,
    loadFailed,
    openItemCount: openItems.length,
    page: currentPage.page,
  });

  useEffect(() => {
    if (requestedPage !== currentPage.page) setRequestedPage(currentPage.page);
  }, [currentPage.page, requestedPage]);

  const controlsDisabled = busy || routeControlsDisabled;

  function acquireRouteIntent(
    options?: ShiftSelectionRouteIntentOptions,
  ): ShiftSelectionRouteIntent | null {
    if (controlsDisabled || (options?.allowSealedCredential !== true && isCurrent?.() === false))
      return null;
    return onRouteIntent?.(options) ?? null;
  }

  async function enterShift(
    resolveShift: () => Promise<{ id: string; status: string; mode: string }>,
  ): Promise<void> {
    if (controlsDisabled) return;
    const intent = acquireRouteIntent();
    if (onRouteIntent && !intent) return;
    const operation = ++shiftEntryOperation.current;
    let lease: ShiftEntryLease | null = null;
    let committed = false;
    const current = (): boolean =>
      mounted.current &&
      shiftEntryOperation.current === operation &&
      isCurrent?.() !== false &&
      (lease?.isCurrent() ?? true);
    setError(null);
    setBusy(true);
    try {
      if (intent) {
        await intent.ready;
        if (!current()) return;
      }
      if (acquireShiftEntry) {
        lease = await acquireShiftEntry();
        if (!current()) return;
      }
      const entered = await resolveShift();
      if (!current()) return;
      if (intent && !intent.commit()) return;
      committed = true;
      if (lease) await onSelected(entered, lease);
      else await onSelected(entered);
    } catch (err) {
      if (current()) {
        setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
      }
    } finally {
      if (!committed && intent) {
        await intent.cancel().catch((cancelError: unknown) => {
          console.error("station: route acquisition cancellation failed", cancelError);
        });
      }
      const resetBusy =
        mounted.current && shiftEntryOperation.current === operation && isCurrent?.() !== false;
      lease?.release();
      if (resetBusy) setBusy(false);
    }
  }

  async function open(shift: ShiftListItem): Promise<void> {
    await enterShift(() =>
      client.post<{ id: string; status: string; mode: string }>(`/shifts/${shift.id}/open`),
    );
  }

  async function rejoin(shift: ShiftListItem): Promise<void> {
    if (!onRouteIntent && !acquireShiftEntry) {
      if (controlsDisabled || isCurrent?.() === false) return;
      setError(null);
      setBusy(true);
      try {
        await onSelected(shift);
      } catch {
        if (mounted.current && isCurrent?.() !== false) setError(t("shifts.actionFailed"));
      } finally {
        if (mounted.current && isCurrent?.() !== false) setBusy(false);
      }
      return;
    }
    await enterShift(() => Promise.resolve(shift));
  }

  async function enterRoute(enter: () => void, options?: ShiftSelectionRouteIntentOptions) {
    if (!onRouteIntent) {
      if (controlsDisabled || (options?.allowSealedCredential !== true && isCurrent?.() === false))
        return;
      enter();
      return;
    }
    const intent = acquireRouteIntent(options);
    if (!intent) return;
    setError(null);
    setBusy(true);
    let committed = false;
    try {
      await intent.ready;
      if (
        !mounted.current ||
        (options?.allowSealedCredential !== true && isCurrent?.() === false)
      ) {
        await intent.cancel();
        return;
      }
      if (!intent.commit()) {
        await intent.cancel();
        return;
      }
      committed = true;
      enter();
    } catch (err) {
      await intent.cancel().catch((cancelError: unknown) => {
        console.error("station: route acquisition cancellation failed", cancelError);
      });
      if (mounted.current && (options?.allowSealedCredential === true || isCurrent?.() !== false)) {
        setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
      }
    } finally {
      if (
        !committed &&
        mounted.current &&
        (options?.allowSealedCredential === true || isCurrent?.() !== false)
      )
        setBusy(false);
    }
  }

  const message = error ? <Alert tone="error">{error}</Alert> : <span aria-hidden="true" />;

  return (
    <StationScreen
      title={title ?? t("shifts.title")}
      header={
        <>
          <div className="shift-selection__message">{message}</div>
          {headerAction ? (
            <div className="shift-selection__header-action">{headerAction(openItems.length)}</div>
          ) : null}
        </>
      }
      actions={
        <FloorFooter ariaLabel={actionsLabel ?? t("shifts.actions")}>
          {productionActionsVisible ? (
            <Button size="floor" disabled={controlsDisabled} onClick={() => void enterRoute(onNew)}>
              {t("shifts.new")}
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="shift-selection__secondary-actions">
            <Button
              size="floor"
              variant="secondary"
              disabled={manualRefreshing || controlsDisabled}
              onClick={() => refreshShifts({ manual: true })}
            >
              {refreshLabel ?? t("shifts.refresh")}
            </Button>
            {onSetup ? (
              <Button
                size="floor"
                variant="secondary"
                disabled={controlsDisabled}
                onClick={() => void enterRoute(onSetup, { allowSealedCredential: true })}
              >
                {t("shell.setup")}
              </Button>
            ) : null}
            {onConflicts ? (
              <Button
                size="floor"
                variant="secondary"
                disabled={controlsDisabled}
                onClick={() => void enterRoute(onConflicts)}
              >
                {t("shell.conflicts")}
              </Button>
            ) : null}
          </div>
        </FloorFooter>
      }
    >
      <div
        className={`shift-selection__content${alternateActive ? " shift-selection__content--alternate" : ""}`}
      >
        <div className="shift-selection__slot">
          {alternateActive ? (
            alternateContent
          ) : persistentState === "loading" ? (
            <p className="shift-selection__state" role="status">
              {t("shifts.loading")}
            </p>
          ) : persistentState === "read-error" ? (
            <div className="shift-selection__state">
              <Button
                size="floor"
                variant="secondary"
                disabled={manualRefreshing}
                onClick={() => refreshShifts({ manual: true })}
              >
                {t("shifts.retry")}
              </Button>
            </div>
          ) : persistentState === "empty" ? (
            /* Static by design: the poll must never animate anything centred here. */
            <div className="shift-selection__state shift-selection__state--empty">
              <span className="shift-selection__empty-mark" aria-hidden="true" />
              <p>{t("shifts.empty")}</p>
              <p className="shift-selection__state-hint">{t("shifts.emptyHint")}</p>
            </div>
          ) : (
            <div className="shift-selection__grid">
              {currentPage.items.map((shift) => (
                <ShiftCard
                  key={shift.id}
                  number={shift.number ?? null}
                  productName={shift.productPrintName ?? shift.productName}
                  plannedDate={shift.plannedDate}
                  productionDate={shift.productionDate ?? null}
                  productionDateLabel={t("shifts.productionShort")}
                  locale={i18n.resolvedLanguage ?? i18n.language}
                  plannedQty={shift.plannedQty}
                  mode={shift.mode}
                  status={shift.status}
                  modeLabel={
                    shift.mode === "aggregation" ? t("shifts.aggregation") : t("shifts.validation")
                  }
                  statusLabel={
                    shift.status === "active" ? t("shifts.active") : t("shifts.notStarted")
                  }
                  plannedLabel={t("shifts.planned")}
                  noPlanLabel={t("shifts.noPlan")}
                  counterpartyName={shift.counterpartyName ?? null}
                  counterpartyLabel={t("shifts.forCounterparty")}
                  actionLabel={shift.status === "active" ? t("shifts.rejoin") : t("shifts.open")}
                  active={shift.status === "active"}
                  disabled={controlsDisabled}
                  onSelect={() =>
                    shift.status === "active" ? void rejoin(shift) : void open(shift)
                  }
                  exec={exec}
                  productId={shift.productId}
                  image={shift.image}
                  imageRefreshKey={imageRefreshKey}
                />
              ))}
            </div>
          )}
        </div>
        {alternateActive ? null : (
          <Pager
            page={currentPage.page}
            pageCount={currentPage.pageCount}
            onPageChange={setRequestedPage}
            ariaLabel={t("shifts.pagination")}
            previousLabel={t("shifts.previousPage")}
            nextLabel={t("shifts.nextPage")}
            pageLabel={(page, pageCount) => t("shifts.page", { page, pageCount })}
            className="shift-selection__pager"
          />
        )}
      </div>
    </StationScreen>
  );
}
