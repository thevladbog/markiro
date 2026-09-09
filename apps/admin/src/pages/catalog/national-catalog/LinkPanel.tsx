import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { Alert, Button, ConfirmDialog, SidePanel, Spinner } from "@markiro/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router";
import { useCan } from "../../../access/context.js";
import { ApiRequestError } from "../../../api/client.js";
import { PRODUCTS_QUERY_KEY, PRODUCT_CHZ_LINK_QUERY_KEY } from "../api.js";
import { closeCatalogPanel, type CatalogPanelContext } from "../ProductPanelRoute.js";
import { ChzStatus } from "./ChzStatus.js";
import * as api from "./api.js";

export function LinkPanel() {
  const { productId = "" } = useParams();
  return <ScopedLinkPanel key={productId} productId={productId} />;
}
function ScopedLinkPanel({ productId }: { productId: string }) {
  const { t, i18n } = useTranslation();
  const tr = (key: string) => t(`pages.catalog.chz.${key}`);
  const location = useLocation();
  const navigate = useNavigate();
  const context = useOutletContext<CatalogPanelContext>();
  const product = context.products.find((item) => item.id === productId);
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const client = useQueryClient();
  const key = [...PRODUCT_CHZ_LINK_QUERY_KEY, productId];
  const detail = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.getChzLink(productId, signal),
    retry: false,
    refetchInterval: (q) => (q.state.data?.summary.refreshing ? 2000 : false),
  });
  const capabilities = useQuery({
    queryKey: ["national-catalog", "link-capabilities"],
    queryFn: ({ signal }) => api.getCapabilities(signal),
    retry: false,
    enabled: canWrite,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingRevision, setRemovingRevision] = useState<number | null>(null);
  const active = useRef(true);
  const lock = useRef(false);
  const abort = useRef(new AbortController());
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    abort.current = controller;
    return () => {
      active.current = false;
      controller.abort();
    };
  }, []);
  const observedSummary = useRef<string | null>(null);
  useEffect(() => {
    if (!detail.data) return;
    const next = JSON.stringify(detail.data.summary);
    if (observedSummary.current !== null && observedSummary.current !== next)
      void client.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    observedSummary.current = next;
  }, [detail.data, client]);
  const link = detail.data?.link;
  const summary = detail.data?.summary;
  const archived = summary?.statusKeys.includes("archived") === true;
  const ready = capabilities.data?.connection.state === "ready";
  const connection = capabilities.data?.connection;
  const reason =
    connection && connection.state !== "ready"
      ? tr(connection.state === "missing" ? "connectionMissing" : connection.reason)
      : null;
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (active.current) {
        setRemovingRevision(null);
        setError(
          tr(
            cause instanceof ApiRequestError && cause.status === 409
              ? "conflict"
              : cause instanceof ApiRequestError && [402, 403].includes(cause.status)
                ? "readOnly"
                : "requestError",
          ),
        );
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function invalidate() {
    await Promise.all([
      client.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY }),
      client.invalidateQueries({ queryKey: key }),
    ]);
  }
  function compare() {
    const gtin = link?.boundGtin14 ?? product?.gtin14;
    if (!gtin) return;
    void run(async () => {
      const session = await api.startImport({ mode: "gtins", text: gtin }, abort.current.signal);
      if (!active.current) return;
      const params = new URLSearchParams({ sessionId: session.id });
      if (link) {
        params.set("exactCardId", link.cardId);
        params.set("exactGtin", link.boundGtin14);
        params.set("originProductId", productId);
      }
      // Push the comparison above the saved link panel; its close returns here,
      // while the catalog parent and its filters stay mounted throughout.
      await navigate(`/catalog/import?${params}`, { state: { catalogBackground: true } });
    });
  }
  return (
    <SidePanel
      open
      title={tr("title")}
      closeLabel={t("common.close")}
      busy={busy}
      onClose={() => closeCatalogPanel(location, navigate)}
    >
      <div className="mk-chz-link">
        {product && <h3>{product.name}</h3>}
        {detail.isPending && <Spinner label={t("common.loading")} />}
        {detail.isError && <Alert tone="error">{tr("unavailable")}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        {detail.data && (
          <>
            <ChzStatus summary={summary} />
            {link && (
              <dl>
                <dt>{tr("cardId")}</dt>
                <dd>{link.cardId}</dd>
                <dt>{tr("environment")}</dt>
                <dd>{tr(link.environment)}</dd>
                <dt>{tr("boundGtin")}</dt>
                <dd>{link.boundGtin14}</dd>
                <dt>{tr("confirmedAt")}</dt>
                <dd>
                  <time dateTime={link.confirmedAt}>
                    {new Date(link.confirmedAt).toLocaleString(i18n.language)}
                  </time>
                </dd>
              </dl>
            )}
            {!canWrite && <Alert>{tr("readOnly")}</Alert>}
            {archived && <Alert>{tr("archived")}</Alert>}
            {canWrite && (
              <>
                {reason && <Alert>{reason}</Alert>}
                {capabilities.isError && <Alert>{tr("unavailable")}</Alert>}
                {capabilities.data && !capabilities.data.gtinLookup && !reason && (
                  <p>{tr("lookupDisabled")}</p>
                )}
                <div className="mk-nc-actions">
                  {link && (
                    <Button
                      variant="secondary"
                      disabled={busy || !ready || summary?.refreshing}
                      onClick={() =>
                        void run(async () => {
                          const next = await api.refreshChzLink(productId, abort.current.signal);
                          if (!active.current) return;
                          client.setQueryData(key, { ...detail.data, summary: next });
                          await invalidate();
                        })
                      }
                    >
                      {tr("refresh")}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={
                      busy || archived || !capabilities.data?.gtinLookup || (!link && !product)
                    }
                    onClick={compare}
                  >
                    {tr(link ? "compare" : "lookup")}
                  </Button>
                  {link && (
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setRemovingRevision(link.revision)}
                    >
                      {tr("remove")}
                    </Button>
                  )}
                </div>
              </>
            )}
          </>
        )}
        <Button variant="secondary" disabled={busy} onClick={() => void detail.refetch()}>
          {tr("reload")}
        </Button>
      </div>
      <ConfirmDialog
        open={removingRevision !== null}
        title={tr("remove")}
        description={tr("removeHint")}
        cancelLabel={t("pages.catalog.cancel")}
        confirmLabel={tr("removeConfirm")}
        tone="destructive"
        busy={busy}
        onCancel={() => setRemovingRevision(null)}
        onConfirm={() => {
          if (removingRevision === null) return;
          const revision = removingRevision;
          void run(async () => {
            const next = await api.removeChzLink(productId, revision, abort.current.signal);
            if (!active.current) return;
            setRemovingRevision(null);
            client.setQueryData(key, { summary: next, link: null });
            await invalidate();
          });
        }}
      />
    </SidePanel>
  );
}
