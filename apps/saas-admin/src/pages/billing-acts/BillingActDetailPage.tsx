import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { Alert, Button, SectionHeader, Spinner, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { getBillingRequest } from "../billing-requests/api.js";
import { getInvoice } from "../billing/api.js";
import { getBillingAct, getBillingActDocumentDownload } from "./api.js";

export function BillingActDetailPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const { actId } = useParams();
  const [downloadBlocked, setDownloadBlocked] = useState(false);
  const detail = useQuery({
    queryKey: ["platform", "billing", "acts", actId],
    queryFn: () => getBillingAct(actId!),
    enabled: Boolean(actId) && principal.capabilities.includes("billing.read"),
  });
  const invoice = useQuery({
    queryKey: ["platform", "invoices", detail.data?.invoiceId],
    queryFn: () => getInvoice(detail.data!.invoiceId!),
    enabled: Boolean(detail.data?.invoiceId),
  });
  const request = useQuery({
    queryKey: ["platform", "billing", "requests", detail.data?.requestId],
    queryFn: () => getBillingRequest(detail.data!.requestId!),
    enabled: Boolean(detail.data?.requestId),
  });
  const downloadDocument = useMutation({
    mutationFn: (documentId: string) => getBillingActDocumentDownload(actId!, documentId),
  });

  if (!principal.capabilities.includes("billing.read")) {
    return (
      <section className="catalog-page">
        <h1>{t("billingActs.detail.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingActs.detail.forbiddenBody")}</Alert>
      </section>
    );
  }
  if (detail.isPending) return <Spinner label={t("shell.routeLoading")} />;
  if (detail.error || !detail.data) {
    return (
      <section className="catalog-page">
        <h1>{t("billingActs.detail.title")}</h1>
        <Alert tone="error">{t("billingActs.detail.loadError")}</Alert>
      </section>
    );
  }

  const act = detail.data;
  const openDocument = (documentId: string) => {
    setDownloadBlocked(false);
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setDownloadBlocked(true);
      return;
    }
    target.opener = null;
    void downloadDocument
      .mutateAsync(documentId)
      .then(({ url }) => target.location.replace(url))
      .catch(() => target.close());
  };
  return (
    <section className="invoice-detail-page billing-act-detail">
      <div className="invoice-detail-backline">
        <Link to="/billing-acts">← {t("billingActs.backToRegistry")}</Link>
      </div>
      <SectionHeader
        eyebrow="COMMERCE / ACTS / DETAIL"
        title={act.number}
        description={t("billingActs.detail.description")}
        actionsLabel={t("billingActs.actions")}
        actions={
          <div className="billing-request-actions">
            <StatusChip
              status={act.status === "issued" ? "ok" : act.status === "draft" ? "warn" : "neutral"}
              label={t(`billingActs.status.${act.status}`)}
            />
            {act.requestId ? (
              <Link to={`/billing-requests/${act.requestId}`}>
                {request.data?.number ?? t("billingActs.detail.openRequest")}
              </Link>
            ) : null}
          </div>
        }
      />
      <p className="invoice-tenant-link">
        <span>{t("billingActs.fields.tenant")}</span>
        <Link to={`/tenants/${act.tenantId}`}>
          {invoice.data?.tenantName ?? t("billingActs.detail.openTenant")}
        </Link>
      </p>
      {act.invoiceId ? (
        <p className="invoice-tenant-link">
          <span>{t("billingActs.fields.invoice")}</span>
          <Link to={`/invoices/${act.invoiceId}`}>
            {invoice.data?.number ?? t("billingActs.detail.openInvoice")}
          </Link>
        </p>
      ) : null}

      <div className="invoice-summary-grid">
        <article className="invoice-hero" data-state={act.status}>
          <span className="invoice-kicker">01 / CLOSING DOCUMENT</span>
          <h2>{t(`billingActs.detail.state.${act.status}.title`)}</h2>
          <p>{t(`billingActs.detail.state.${act.status}.body`)}</p>
        </article>
        <dl className="invoice-facts">
          <div>
            <dt>{t("billingActs.fields.periodStart")}</dt>
            <dd>{formatCivilDate(act.periodStart, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("billingActs.fields.periodEnd")}</dt>
            <dd>{formatCivilDate(act.periodEnd, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("billingActs.detail.issuedAt")}</dt>
            <dd>{formatDate(act.issuedAt, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("billingActs.preview.total")}</dt>
            <dd className="mono">
              {invoice.data ? formatMoney(invoice.data.total, i18n.language) : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {act.invoiceId && invoice.isPending ? (
        <Spinner label={t("billingActs.source.loadingDetail")} />
      ) : null}
      {act.invoiceId && invoice.error ? (
        <Alert tone="error">{t("billingActs.detail.invoiceLoadError")}</Alert>
      ) : null}
      {invoice.data ? (
        <section className="invoice-panel" aria-labelledby="billing-act-lines-title">
          <header>
            <div>
              <span className="invoice-kicker">02 / LINES</span>
              <h2 id="billing-act-lines-title">{t("billingActs.detail.linesTitle")}</h2>
              <p>{t("billingActs.detail.linesDescription")}</p>
            </div>
          </header>
          <div className="invoice-table-scroll" tabIndex={0}>
            <table className="invoice-lines-table">
              <thead>
                <tr>
                  <th>{t("billing.position")}</th>
                  <th>{t("billing.item")}</th>
                  <th>{t("documents.columns.quantity")}</th>
                  <th>{t("billing.total")}</th>
                </tr>
              </thead>
              <tbody>
                {invoice.data.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="mono">{String(line.position).padStart(2, "0")}</td>
                    <td>
                      <strong>{line.nameRu}</strong>
                      {line.descriptionRu ? <small>{line.descriptionRu}</small> : null}
                    </td>
                    <td>
                      {line.quantity} {line.unit}
                    </td>
                    <td className="mono">{formatMoney(line.lineTotal, i18n.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section
        className="invoice-panel invoice-documents"
        aria-labelledby="billing-act-document-title"
      >
        <header>
          <div>
            <span className="invoice-kicker">03 / DOCUMENT</span>
            <h2 id="billing-act-document-title">{t("billingActs.detail.documentTitle")}</h2>
            <p>{t("billingActs.detail.documentDescription")}</p>
          </div>
        </header>
        {downloadDocument.isError || downloadBlocked ? (
          <Alert tone="error">
            {downloadBlocked
              ? t("billingActs.detail.popupBlocked")
              : t("billingActs.detail.downloadError")}
          </Alert>
        ) : null}
        {act.document ? (
          <div className="invoice-documents__list">
            <section className="invoice-documents__revision">
              <h3>{t("billingActs.detail.revision", { revision: act.document.revision })}</h3>
              <div className="invoice-documents__row">
                <div>
                  <strong>PDF</strong>
                  <span>{t(`billingActs.detail.documentState.${act.document.state}`)}</span>
                  <small>{t(`billingActs.print.variant.${act.document.printVariant}`)}</small>
                </div>
                {act.document.state === "ready" ? (
                  <Button
                    variant="secondary"
                    loading={downloadDocument.isPending}
                    onClick={() => openDocument(act.document!.id)}
                  >
                    {t("billingActs.detail.downloadPdf")}
                  </Button>
                ) : null}
              </div>
            </section>
          </div>
        ) : (
          <p className="invoice-documents__draft-note">
            {t("billingActs.detail.documentUnavailable")}
          </p>
        )}
      </section>
    </section>
  );
}

function formatMoney(value: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 2,
  }).format(Number(value));
}

function formatCivilDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}

function formatDate(value: string | null, locale: string): string {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "—";
}
