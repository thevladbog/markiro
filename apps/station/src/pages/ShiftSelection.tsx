import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Pager } from "@markiro/ui";
import { StationApiError, type StationClient } from "../lib/api-client.js";
import { paginate } from "../lib/pagination.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { ShiftCard } from "../ui/ShiftCard.js";
import type { SqlExecutor } from "../lib/mirror.js";
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
  status: "planned" | "active" | "closed";
  mode: "validation" | "aggregation";
  productName: string | null;
  plannedQty: number | null;
  plannedDate: string | null;
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
  onSelected: (shift: { id: string; status: string; mode: string }) => void;
  onNew: () => void;
  /** Opens the workstation setup screen; omitted where there is no way in. */
  onSetup?: () => void;
  /** Opens the conflict list; omitted where there is no way in. */
  onConflicts?: () => void;
  /** False once this credential generation is sealed or this floor is retired. */
  isCurrent?: () => boolean;
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
  onSelected,
  onNew,
  onSetup,
  onConflicts,
  isCurrent,
}: ShiftSelectionProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ShiftListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [imageRefreshKey, setImageRefreshKey] = useState(0);
  const [requestedPage, setRequestedPage] = useState(1);
  const mounted = useRef(true);
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
    };
  }, []);

  const refreshShifts = useCallback(() => {
    if (listRequest.current?.client === client) return;

    const id = ++listRequestId.current;
    listRequest.current = { client, id };
    const initialForClient = loadedClient.current !== client;
    if (initialForClient) setLoading(true);
    setRefreshing(true);
    setLoadFailed(false);
    setError(null);
    void client
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
      })
      .finally(() => {
        if (!mounted.current || listRequest.current?.id !== id) return;
        listRequest.current = null;
        setRefreshing(false);
      });
  }, [client, exec, t]);

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

  async function open(shift: ShiftListItem) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const opened = await client.post<{ id: string; status: string; mode: string }>(
        `/shifts/${shift.id}/open`,
      );
      if (!mounted.current || isCurrent?.() === false) return;
      onSelected(opened);
    } catch (err) {
      if (!mounted.current || isCurrent?.() === false) return;
      setError(err instanceof StationApiError ? err.message : t("shifts.actionFailed"));
    } finally {
      if (mounted.current && isCurrent?.() !== false) setBusy(false);
    }
  }

  function rejoin(shift: ShiftListItem) {
    if (busy || isCurrent?.() === false) return;
    onSelected(shift);
  }

  const message = error ? <Alert tone="error">{error}</Alert> : <span aria-hidden="true" />;

  return (
    <StationScreen
      title={t("shifts.title")}
      header={<div className="shift-selection__message">{message}</div>}
      actions={
        <FloorFooter ariaLabel={t("shifts.actions")}>
          <Button size="floor" onClick={onNew}>
            {t("shifts.new")}
          </Button>
          <div className="shift-selection__secondary-actions">
            {onSetup ? (
              <Button size="floor" variant="secondary" onClick={onSetup}>
                {t("shell.setup")}
              </Button>
            ) : null}
            {onConflicts ? (
              <Button size="floor" variant="secondary" disabled={busy} onClick={onConflicts}>
                {t("shell.conflicts")}
              </Button>
            ) : null}
          </div>
        </FloorFooter>
      }
    >
      <div className="shift-selection__content">
        <div className="shift-selection__slot">
          {persistentState === "loading" ? (
            <p className="shift-selection__state" role="status">
              {t("shifts.loading")}
            </p>
          ) : persistentState === "read-error" ? (
            <div className="shift-selection__state">
              <Button
                size="floor"
                variant="secondary"
                disabled={refreshing}
                onClick={refreshShifts}
              >
                {t("shifts.retry")}
              </Button>
            </div>
          ) : persistentState === "empty" ? (
            <div className="shift-selection__state">
              <p>{t("shifts.empty")}</p>
              <Button
                size="floor"
                variant="secondary"
                disabled={refreshing}
                onClick={refreshShifts}
              >
                {t("shifts.refresh")}
              </Button>
            </div>
          ) : (
            <div className="shift-selection__grid">
              {currentPage.items.map((shift) => (
                <ShiftCard
                  key={shift.id}
                  productName={shift.productName}
                  plannedDate={shift.plannedDate}
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
                  disabled={busy}
                  onSelect={() => (shift.status === "active" ? rejoin(shift) : void open(shift))}
                  exec={exec}
                  productId={shift.productId}
                  image={shift.image}
                  imageRefreshKey={imageRefreshKey}
                />
              ))}
            </div>
          )}
        </div>
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
      </div>
    </StationScreen>
  );
}
