import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Pager } from "@markiro/ui";
import { StationApiError, type StationClient } from "../lib/api-client.js";
import { paginate } from "../lib/pagination.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { ShiftCard } from "../ui/ShiftCard.js";
import { StationScreen } from "../ui/StationScreen.js";
import { prefetchStationProductImage } from "../lib/product-image-cache.js";

const SHIFT_PAGE_SIZE = 3;

interface ShiftListItem {
  id: string;
  status: "planned" | "active" | "closed";
  mode: "validation" | "aggregation";
  productName: string | null;
  plannedQty: number | null;
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

export interface ShiftSelectionProps {
  client: StationClient;
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [requestedPage, setRequestedPage] = useState(1);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    client
      .get<{ items: ShiftListItem[] }>("/shifts")
      .then((response) => {
        if (cancelled) return;
        setItems(response.items);
        for (const shift of response.items) {
          void prefetchStationProductImage(client, {
            id: shift.productId,
            ...(shift.image === undefined ? {} : { image: shift.image }),
          });
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof StationApiError ? err.message : t("shifts.serverUnavailable"));
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, loadAttempt, t]);

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
              <Button size="floor" variant="secondary" onClick={() => setLoadAttempt((n) => n + 1)}>
                {t("shifts.retry")}
              </Button>
            </div>
          ) : persistentState === "empty" ? (
            <p className="shift-selection__state">{t("shifts.empty")}</p>
          ) : (
            <div className="shift-selection__grid">
              {currentPage.items.map((shift) => (
                <ShiftCard
                  key={shift.id}
                  productName={shift.productName}
                  counterpartyName={shift.counterpartyName ?? null}
                  counterpartyLabel={t("shifts.forCounterparty")}
                  actionLabel={shift.status === "active" ? t("shifts.rejoin") : t("shifts.open")}
                  active={shift.status === "active"}
                  disabled={busy}
                  onSelect={() => (shift.status === "active" ? rejoin(shift) : void open(shift))}
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
