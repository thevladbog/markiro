import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { useProducts } from "../catalog/api.js";
import type { KioskDto } from "./api.js";
import { useSetKioskProducts } from "./api.js";

export interface KioskProductsSectionProps {
  kiosk: KioskDto;
  disabled?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
  onStatusChange?: (status: KioskProductsSectionStatus) => void;
}

export type KioskProductsSectionPhase = "loading" | "error" | "ready";

export interface KioskProductsSectionStatus {
  phase: KioskProductsSectionPhase;
  selectedCount: number;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every((id) => right.has(id));
}

function saveError(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * Owns a kiosk's independently recoverable active-product allowlist. The
 * catalog query deliberately mounts only when the authorized edit surface does.
 */
export function KioskProductsSection({
  kiosk,
  disabled = false,
  onDirtyChange,
  onBusyChange,
  onErrorChange,
  onStatusChange,
}: KioskProductsSectionProps) {
  const { t } = useTranslation();
  const query = useProducts({ status: "active" });
  const setProductsMutation = useSetKioskProducts();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(kiosk.productIds));
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set(kiosk.productIds));
  const [search, setSearch] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const previousKioskRef = useRef({ id: kiosk.id, productIds: new Set(kiosk.productIds) });

  const dirty = !sameIds(selectedIds, savedIds);
  const busy = setProductsMutation.isPending;
  const hasError = query.isError || mutationError !== null;
  const phase: KioskProductsSectionPhase = query.isPending
    ? "loading"
    : query.isError
      ? "error"
      : "ready";
  const products = useMemo(() => query.data ?? [], [query.data]);
  const normalizedSearch = search.trim().normalize().toLocaleLowerCase();
  const filteredProducts = useMemo(
    () =>
      products.filter(
        (product) =>
          normalizedSearch.length === 0 ||
          product.name.normalize().toLocaleLowerCase().includes(normalizedSearch) ||
          product.gtin14.includes(search.trim()),
      ),
    [normalizedSearch, products, search],
  );

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => onErrorChange(hasError), [hasError, onErrorChange]);
  useEffect(
    () => onStatusChange?.({ phase, selectedCount: selectedIds.size }),
    [onStatusChange, phase, selectedIds.size],
  );
  useEffect(() => {
    const incomingIds = new Set(kiosk.productIds);
    const previousKiosk = previousKioskRef.current;
    const kioskChanged =
      previousKiosk.id !== kiosk.id || !sameIds(previousKiosk.productIds, incomingIds);

    if (kioskChanged) {
      if (dirty) return;

      setSelectedIds(incomingIds);
      setSavedIds(new Set(incomingIds));
      setMutationError(null);
      previousKioskRef.current = { id: kiosk.id, productIds: incomingIds };
    }
  }, [dirty, kiosk.id, kiosk.productIds]);

  const toggleProduct = (productId: string) => {
    if (disabled || busy) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const saveProducts = async () => {
    if (disabled || busy || query.data === undefined) return;

    const productIds = query.data
      .filter((product) => selectedIds.has(product.id))
      .map((product) => product.id);

    try {
      setMutationError(null);
      await setProductsMutation.mutateAsync({ id: kiosk.id, productIds });
      const persistedIds = new Set(productIds);
      setSelectedIds(persistedIds);
      setSavedIds(new Set(persistedIds));
      toast("ok", t("pages.kiosks.toasts.setProductsSuccess"));
    } catch (error) {
      setMutationError(saveError(error, t("pages.kiosks.products.saveError")));
    }
  };

  return (
    <section
      className="mk-kiosk-products-section"
      role="region"
      aria-label={t("pages.kiosks.products.title")}
    >
      <h3 className="mk-kiosk-products-section__title" tabIndex={-1}>
        {t("pages.kiosks.products.title")}
      </h3>

      {mutationError ? <Alert tone="error">{mutationError}</Alert> : null}

      {query.isPending ? (
        <div className="mk-kiosk-products-section__skeleton" aria-busy="true">
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span
            role="status"
            aria-label={t("pages.kiosks.products.loading")}
            className="mk-visually-hidden"
          >
            {t("pages.kiosks.products.loading")}
          </span>
        </div>
      ) : query.isError ? (
        <div className="mk-kiosk-products-section__state">
          <Alert tone="error">{t("pages.kiosks.products.loadError")}</Alert>
          <div>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => void query.refetch()}
            >
              {t("pages.kiosks.products.retryAction")}
            </Button>
          </div>
        </div>
      ) : products.length === 0 ? (
        <p className="mk-kiosk-products-section__empty">{t("pages.kiosks.products.emptyHint")}</p>
      ) : (
        <>
          <div className="mk-kiosk-products-section__controls">
            <Input
              className="mk-kiosk-products-section__search"
              label={t("pages.kiosks.products.searchLabel")}
              value={search}
              disabled={disabled || busy}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span className="mk-kiosk-products-section__selected-count" aria-live="polite">
              {t("pages.kiosks.products.selectedCount", { count: selectedIds.size })}
            </span>
          </div>
          <div className="mk-kiosk-products-section__list">
            {filteredProducts.map((product) => (
              <div className="mk-kiosk-products-section__product" key={product.id}>
                <Checkbox
                  label={product.name}
                  checked={selectedIds.has(product.id)}
                  disabled={disabled || busy}
                  onCheckedChange={() => toggleProduct(product.id)}
                />
                <span className="mk-kiosk-products-section__gtin">{product.gtin14}</span>
              </div>
            ))}
          </div>
          <div className="mk-kiosk-products-section__actions">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || !dirty}
              loading={busy}
              onClick={() => void saveProducts()}
            >
              {t("pages.kiosks.products.saveAction")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
