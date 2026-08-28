import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, EmptyState, Input, Select, Spinner, Table } from "@markiro/ui";

import {
  downloadActDocument,
  downloadOfferDocument,
  type DocumentFilters,
  type TenantDocument,
  useDocuments,
} from "./api.js";
import { formatBillingDate } from "./format.js";

type DocumentStatusFilter = "" | TenantDocument["status"];

export function DocumentsPage() {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useState<DocumentFilters>({});
  const [status, setStatus] = useState<DocumentStatusFilter>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const { data, isPending, isError } = useDocuments(filters);
  const clear = (key: keyof DocumentFilters) => {
    const next = { ...filters };
    delete next[key];
    return next;
  };
  const documents = useMemo(
    () => (data?.items ?? []).filter((document) => !status || document.status === status),
    [data?.items, status],
  );
  const download = (document: TenantDocument) =>
    void (async () => {
      setBusy(document.id);
      setDownloadError(false);
      try {
        const result =
          document.type === "offer"
            ? await downloadOfferDocument(document.entityId, document.id)
            : await downloadActDocument(document.entityId, document.id);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError(true);
      } finally {
        setBusy(null);
      }
    })();
  if (isPending) return <Spinner label={t("pages.billing.documents.loading")} />;
  if (isError) return <EmptyState title={t("pages.billing.documents.loadError")} />;
  return (
    <section aria-labelledby="billing-documents-heading" className="mk-billing-documents">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-documents-heading">
            {t("pages.billing.documents.heading")}
          </h2>
          <p>{t("pages.billing.documents.description")}</p>
        </div>
        <div
          className="mk-billing-filters"
          role="group"
          aria-label={t("pages.billing.documents.filters.label")}
        >
          <Select
            native
            label={t("pages.billing.documents.filters.type")}
            value={filters.type ?? ""}
            onValueChange={(type) => setFilters(type ? { ...filters, type } : clear("type"))}
            options={[
              { value: "", label: t("pages.billing.documents.filters.allTypes") },
              { value: "offer", label: t("pages.billing.documents.filters.offer") },
              { value: "act", label: t("pages.billing.documents.filters.act") },
            ]}
          />
          <Select
            native
            label={t("pages.billing.documents.filters.status")}
            value={status}
            onValueChange={setStatus}
            options={[
              { value: "", label: t("pages.billing.documents.filters.allStatuses") },
              { value: "ready", label: t("pages.billing.documents.status.ready") },
              { value: "pending", label: t("pages.billing.documents.status.pending") },
              { value: "failed", label: t("pages.billing.documents.status.failed") },
            ]}
          />
          <Input
            label={t("pages.billing.documents.filters.from")}
            type="date"
            value={filters.from ?? ""}
            onChange={(event) =>
              setFilters(
                event.target.value ? { ...filters, from: event.target.value } : clear("from"),
              )
            }
          />
          <Input
            label={t("pages.billing.documents.filters.to")}
            type="date"
            value={filters.to ?? ""}
            onChange={(event) =>
              setFilters(event.target.value ? { ...filters, to: event.target.value } : clear("to"))
            }
          />
        </div>
      </div>
      {downloadError ? (
        <Alert tone="error">{t("pages.billing.documents.downloadError")}</Alert>
      ) : null}
      {documents.length === 0 ? (
        <EmptyState title={t("pages.billing.documents.empty")} />
      ) : (
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel={t("pages.billing.documents.registry")}
            columns={[
              {
                key: "type",
                title: t("pages.billing.documents.columns.type"),
                render: (row) => t(`pages.billing.documents.types.${row.type}`),
              },
              {
                key: "createdAt",
                title: t("pages.billing.documents.columns.date"),
                render: (row) => formatBillingDate(row.createdAt, i18n.language),
              },
              {
                key: "revision",
                title: t("pages.billing.documents.columns.revision"),
                mono: true,
              },
              {
                key: "status",
                title: t("pages.billing.documents.columns.status"),
                render: (row) => t(`pages.billing.documents.status.${row.status}`),
              },
              {
                key: "download",
                title: t("pages.billing.documents.columns.file"),
                render: (row) =>
                  row.status === "ready" ? (
                    <Button
                      disabled={busy === row.id}
                      loading={busy === row.id}
                      onClick={() => download(row)}
                    >
                      {t("pages.billing.documents.download")}
                    </Button>
                  ) : (
                    <span>{t(`pages.billing.documents.status.${row.status}`)}</span>
                  ),
              },
            ]}
            rows={documents}
          />
        </div>
      )}
    </section>
  );
}
