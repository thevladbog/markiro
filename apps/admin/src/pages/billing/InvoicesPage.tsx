import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { Alert, Button, Card, EmptyState, Input, Select, Spinner, Table } from "@markiro/ui";

import { BillingStatusChip } from "./BillingSections.js";
import { ApiRequestError } from "../../api/client.js";
import {
  downloadInvoice,
  type InvoiceFilters,
  type TenantInvoice,
  type TenantInvoiceStatus,
  useInvoice,
  useInvoices,
} from "./api.js";
import { formatBillingDate, formatMoney } from "./format.js";

const INVOICE_STATUSES: TenantInvoiceStatus[] = [
  "issued",
  "overdue",
  "partially_paid",
  "paid",
  "cancelled",
];

function InvoicePaymentSummary({ invoice }: { invoice: TenantInvoice }) {
  const { t, i18n } = useTranslation();
  if (!invoice.paymentSummary) return <span>—</span>;
  return (
    <div className="mk-billing-payment-summary">
      <span className="mk-billing-money">
        {t("pages.billing.invoices.payment.confirmed", {
          amount: formatMoney(
            invoice.paymentSummary.confirmedAmount,
            invoice.currency,
            i18n.language,
          ),
        })}
      </span>
      <span className="mk-billing-money">
        {t("pages.billing.invoices.payment.remaining", {
          amount: formatMoney(
            invoice.paymentSummary.remainingAmount,
            invoice.currency,
            i18n.language,
          ),
        })}
      </span>
    </div>
  );
}

function InvoiceFiltersForm({
  filters,
  onChange,
}: {
  filters: InvoiceFilters;
  onChange: (next: InvoiceFilters) => void;
}) {
  const { t } = useTranslation();
  const clear = (key: keyof InvoiceFilters) => {
    const next = { ...filters };
    delete next[key];
    return next;
  };
  const setStatus = (status: string) =>
    onChange({
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(status ? { status: status as TenantInvoiceStatus } : {}),
    });
  return (
    <div
      className="mk-billing-filters"
      role="group"
      aria-label={t("pages.billing.invoices.filters.label")}
    >
      <Select
        native
        label={t("pages.billing.invoices.filters.status")}
        value={filters.status ?? ""}
        onValueChange={setStatus}
        options={[
          { value: "", label: t("pages.billing.invoices.filters.allStatuses") },
          ...INVOICE_STATUSES.map((status) => ({
            value: status,
            label: t(`pages.billing.status.operation.${status}`),
          })),
        ]}
      />
      <Input
        label={t("pages.billing.invoices.filters.from")}
        type="date"
        value={filters.from ?? ""}
        onChange={(event) =>
          onChange(event.target.value ? { ...filters, from: event.target.value } : clear("from"))
        }
      />
      <Input
        label={t("pages.billing.invoices.filters.to")}
        type="date"
        value={filters.to ?? ""}
        onChange={(event) =>
          onChange(event.target.value ? { ...filters, to: event.target.value } : clear("to"))
        }
      />
    </div>
  );
}

export function InvoicesPage() {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useState<InvoiceFilters>({});
  const { data, isPending, isError, refetch } = useInvoices(filters);
  if (isPending) return <Spinner label={t("pages.billing.invoices.loading")} />;
  if (isError)
    return (
      <EmptyState
        title={t("pages.billing.invoices.loadError")}
        action={<Button onClick={() => void refetch()}>{t("pages.billing.retry")}</Button>}
      />
    );
  const items = data?.items ?? [];
  return (
    <section aria-labelledby="billing-invoices-heading" className="mk-billing-invoices">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-invoices-heading">
            {t("pages.billing.invoices.heading")}
          </h2>
          <p>{t("pages.billing.invoices.description")}</p>
        </div>
        <InvoiceFiltersForm filters={filters} onChange={setFilters} />
      </div>
      {items.length === 0 ? (
        <EmptyState title={t("pages.billing.invoices.empty")} />
      ) : (
        <>
          <div className="mk-billing-table-wrap mk-billing-invoices__desktop">
            <Table
              scrollLabel={t("pages.billing.invoices.registry")}
              columns={[
                {
                  key: "number",
                  title: t("pages.billing.invoices.columns.number"),
                  render: (row) => <Link to={`/billing/invoices/${row.id}`}>{row.number}</Link>,
                },
                {
                  key: "issueDate",
                  title: t("pages.billing.invoices.columns.issued"),
                  render: (row) => formatBillingDate(row.issueDate, i18n.language),
                },
                {
                  key: "dueDate",
                  title: t("pages.billing.invoices.columns.dueDate"),
                  render: (row) => formatBillingDate(row.dueDate, i18n.language),
                },
                {
                  key: "status",
                  title: t("pages.billing.invoices.columns.status"),
                  render: (row) => <BillingStatusChip kind="operation" value={row.status} />,
                },
                {
                  key: "total",
                  title: t("pages.billing.invoices.columns.total"),
                  mono: true,
                  align: "right",
                  render: (row) => formatMoney(row.total, row.currency, i18n.language),
                },
                {
                  key: "payment",
                  title: t("pages.billing.invoices.columns.confirmedPayment"),
                  render: (row) => <InvoicePaymentSummary invoice={row} />,
                },
              ]}
              rows={items}
            />
          </div>
          <ul
            className="mk-billing-invoice-cards"
            aria-label={t("pages.billing.invoices.cardsLabel")}
          >
            {items.map((invoice) => (
              <li key={invoice.id}>
                <Link to={`/billing/invoices/${invoice.id}`} className="mk-billing-invoice-card">
                  <strong>{invoice.number}</strong>
                  <BillingStatusChip kind="operation" value={invoice.status} />
                  <span>{formatBillingDate(invoice.dueDate, i18n.language)}</span>
                  <span className="mk-billing-money">
                    {formatMoney(invoice.total, invoice.currency, i18n.language)}
                  </span>
                  <InvoicePaymentSummary invoice={invoice} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const { t, i18n } = useTranslation();
  const { data, isPending, isError, error, refetch } = useInvoice(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const handleDownload = (documentId: string) =>
    void (async () => {
      setBusy(documentId);
      setDownloadError(false);
      try {
        const result = await downloadInvoice(id, documentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError(true);
      } finally {
        setBusy(null);
      }
    })();
  if (isPending) return <Spinner label={t("pages.billing.invoices.detail.loading")} />;
  if (isError) {
    const status = error instanceof ApiRequestError ? error.status : 0;
    return (
      <EmptyState
        title={
          status === 404
            ? t("pages.billing.invoices.detail.notFound")
            : status === 403
              ? t("pages.billing.invoices.detail.forbidden")
              : t("pages.billing.invoices.detail.loadError")
        }
        action={
          status === 404 || status === 403 ? undefined : (
            <Button onClick={() => void refetch()}>{t("pages.billing.retry")}</Button>
          )
        }
      />
    );
  }
  if (!data) return <EmptyState title={t("pages.billing.invoices.detail.notFound")} />;
  return (
    <section aria-labelledby="billing-invoice-heading" className="mk-billing-invoice-detail">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-invoice-heading">
            {t("pages.billing.invoices.detail.heading", { number: data.number })}
          </h2>
          <p>{t("pages.billing.invoices.detail.description")}</p>
        </div>
        <Link className="mk-billing-inline-link" to="/billing/invoices">
          {t("pages.billing.invoices.detail.back")}
        </Link>
      </div>
      <Card title={t("pages.billing.invoices.detail.summary")} titleAs="h3">
        <dl className="mk-billing-definition-list">
          <div>
            <dt>{t("pages.billing.invoices.detail.invoiceStatus")}</dt>
            <dd>
              <BillingStatusChip kind="operation" value={data.status} />
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.invoices.detail.paymentStatus")}</dt>
            <dd>
              {data.paymentSummary ? (
                <BillingStatusChip kind="operation" value={data.paymentSummary.status} />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.invoices.detail.invoiceTotal")}</dt>
            <dd className="mk-billing-money">
              {formatMoney(data.total, data.currency, i18n.language)}
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.invoices.detail.confirmed")}</dt>
            <dd className="mk-billing-money">
              {data.paymentSummary
                ? formatMoney(data.paymentSummary.confirmedAmount, data.currency, i18n.language)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.invoices.detail.remaining")}</dt>
            <dd className="mk-billing-money">
              {data.paymentSummary
                ? formatMoney(data.paymentSummary.remainingAmount, data.currency, i18n.language)
                : "—"}
            </dd>
          </div>
        </dl>
      </Card>
      <Card title={t("pages.billing.invoices.detail.payments")} titleAs="h3">
        {data.payments.length ? (
          <ol className="mk-billing-payments-list">
            {data.payments.map((payment) => (
              <li data-testid="confirmed-payment" key={payment.id}>
                <span>{formatBillingDate(payment.paidAt, i18n.language)}</span>
                <strong className="mk-billing-money">
                  {formatMoney(payment.amount, payment.currency, i18n.language)}
                </strong>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mk-billing-muted">{t("pages.billing.invoices.detail.noPayments")}</p>
        )}
      </Card>
      <Card title={t("pages.billing.invoices.detail.lines")} titleAs="h3">
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel={t("pages.billing.invoices.detail.linesRegistry")}
            columns={[
              {
                key: "position",
                title: t("pages.billing.invoices.lineColumns.position"),
                mono: true,
              },
              { key: "nameRu", title: t("pages.billing.invoices.lineColumns.name"), wrap: true },
              { key: "unit", title: t("pages.billing.invoices.lineColumns.unit") },
              {
                key: "quantity",
                title: t("pages.billing.invoices.lineColumns.quantity"),
                mono: true,
                align: "right",
              },
              {
                key: "lineTotal",
                title: t("pages.billing.invoices.lineColumns.total"),
                mono: true,
                align: "right",
                render: (row) => formatMoney(row.lineTotal, data.currency, i18n.language),
              },
            ]}
            rows={data.lines}
          />
        </div>
      </Card>
      <Card title={t("pages.billing.invoices.detail.documents")} titleAs="h3">
        {downloadError ? (
          <Alert tone="error">{t("pages.billing.invoices.downloadError")}</Alert>
        ) : null}
        {data.documents.map((document) => (
          <div className="mk-billing-invoice-document" key={document.id}>
            <span>
              {t("pages.billing.invoices.detail.documentMeta", {
                format: document.format.toUpperCase(),
                revision: document.revision,
                status: t(`pages.billing.documents.status.${document.status}`),
              })}
            </span>
            {document.status === "ready" ? (
              <Button
                disabled={busy === document.id}
                loading={busy === document.id}
                onClick={() => handleDownload(document.id)}
              >
                {t("pages.billing.invoices.download")}
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
    </section>
  );
}
