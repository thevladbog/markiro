import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { Alert, Button, Card, EmptyState, Input, Select, Spinner, Table } from "@markiro/ui";

import { BillingStatusChip } from "./BillingSections.js";
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

function invoiceStatusLabel(status: TenantInvoiceStatus): string {
  return {
    draft: "Черновик",
    issued: "Выставлено",
    overdue: "Просрочено",
    partially_paid: "Оплачено частично",
    paid: "Оплачено",
    cancelled: "Отменено",
  }[status];
}

function InvoicePaymentSummary({ invoice }: { invoice: TenantInvoice }) {
  if (!invoice.paymentSummary) return <span>—</span>;
  return (
    <div className="mk-billing-payment-summary">
      <span className="mk-billing-money">
        Подтверждено:{" "}
        {formatMoney(invoice.paymentSummary.confirmedAmount, invoice.currency, "ru-RU")}
      </span>
      <span className="mk-billing-money">
        Остаток: {formatMoney(invoice.paymentSummary.remainingAmount, invoice.currency, "ru-RU")}
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
  const setStatus = (status: string) =>
    onChange({
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(status ? { status: status as TenantInvoiceStatus } : {}),
    });
  return (
    <div className="mk-billing-filters" role="group" aria-label="Фильтры счетов">
      <Select
        native
        label="Статус счёта"
        value={filters.status ?? ""}
        onValueChange={setStatus}
        options={[
          { value: "", label: "Все статусы" },
          ...INVOICE_STATUSES.map((status) => ({
            value: status,
            label: invoiceStatusLabel(status),
          })),
        ]}
      />
      <Input
        label="С даты"
        type="date"
        value={filters.from ?? ""}
        onChange={(event) =>
          onChange({ ...filters, ...(event.target.value ? { from: event.target.value } : {}) })
        }
      />
      <Input
        label="По дату"
        type="date"
        value={filters.to ?? ""}
        onChange={(event) =>
          onChange({ ...filters, ...(event.target.value ? { to: event.target.value } : {}) })
        }
      />
    </div>
  );
}

export function InvoicesPage() {
  const { i18n } = useTranslation();
  const [filters, setFilters] = useState<InvoiceFilters>({});
  const { data, isPending, isError } = useInvoices(filters);
  if (isPending) return <Spinner label="Загрузка счетов" />;
  if (isError) return <EmptyState title="Не удалось загрузить счета" />;
  const items = data?.items ?? [];
  return (
    <section aria-labelledby="billing-invoices-heading" className="mk-billing-invoices">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-invoices-heading">
            Счета и оплаты
          </h2>
          <p>Показаны только подтверждённые Markiro оплаты.</p>
        </div>
        <InvoiceFiltersForm filters={filters} onChange={setFilters} />
      </div>
      {items.length === 0 ? (
        <EmptyState title="Счетов по выбранным фильтрам нет" />
      ) : (
        <>
          <div className="mk-billing-table-wrap mk-billing-invoices__desktop">
            <Table
              scrollLabel="Реестр счетов"
              columns={[
                {
                  key: "number",
                  title: "Номер",
                  render: (row) => <Link to={`/billing/invoices/${row.id}`}>{row.number}</Link>,
                },
                {
                  key: "issueDate",
                  title: "Выставлен",
                  render: (row) => formatBillingDate(row.issueDate, i18n.language),
                },
                {
                  key: "dueDate",
                  title: "Срок оплаты",
                  render: (row) => formatBillingDate(row.dueDate, i18n.language),
                },
                {
                  key: "status",
                  title: "Статус счёта",
                  render: (row) => <BillingStatusChip kind="operation" value={row.status} />,
                },
                {
                  key: "total",
                  title: "Сумма",
                  mono: true,
                  align: "right",
                  render: (row) => formatMoney(row.total, row.currency, i18n.language),
                },
                {
                  key: "payment",
                  title: "Подтверждённая оплата",
                  render: (row) => <InvoicePaymentSummary invoice={row} />,
                },
              ]}
              rows={items}
            />
          </div>
          <ul className="mk-billing-invoice-cards" aria-label="Счета">
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
  const { i18n } = useTranslation();
  const { data, isPending, isError } = useInvoice(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const handleDownload = (documentId: string) =>
    void (async () => {
      setBusy(documentId);
      setDownloadError(null);
      try {
        const result = await downloadInvoice(id, documentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError("Не удалось скачать документ. Повторите попытку позже.");
      } finally {
        setBusy(null);
      }
    })();
  if (isPending) return <Spinner label="Загрузка счёта" />;
  if (isError || !data) return <EmptyState title="Счёт не найден" />;
  return (
    <section aria-labelledby="billing-invoice-heading" className="mk-billing-invoice-detail">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-invoice-heading">
            Счёт {data.number}
          </h2>
          <p>Неоплаченный счёт сам по себе не ограничивает работу производства.</p>
        </div>
        <Link className="mk-billing-inline-link" to="/billing/invoices">
          К списку счетов
        </Link>
      </div>
      <Card title="Статус и сумма" titleAs="h3">
        <dl className="mk-billing-definition-list">
          <div>
            <dt>Статус счёта</dt>
            <dd>
              <BillingStatusChip kind="operation" value={data.status} />
            </dd>
          </div>
          <div>
            <dt>Статус оплаты</dt>
            <dd>
              {data.paymentSummary ? (
                <BillingStatusChip kind="operation" value={data.paymentSummary.status} />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Сумма счёта</dt>
            <dd className="mk-billing-money">
              {formatMoney(data.total, data.currency, i18n.language)}
            </dd>
          </div>
          <div>
            <dt>Подтверждено</dt>
            <dd className="mk-billing-money">
              {data.paymentSummary
                ? formatMoney(data.paymentSummary.confirmedAmount, data.currency, i18n.language)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Остаток</dt>
            <dd className="mk-billing-money">
              {data.paymentSummary
                ? formatMoney(data.paymentSummary.remainingAmount, data.currency, i18n.language)
                : "—"}
            </dd>
          </div>
        </dl>
      </Card>
      <Card title="Подтверждённые оплаты" titleAs="h3">
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
          <p className="mk-billing-muted">Подтверждённых оплат пока нет.</p>
        )}
      </Card>
      <Card title="Позиции" titleAs="h3">
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel="Позиции счёта"
            columns={[
              { key: "position", title: "№", mono: true },
              { key: "nameRu", title: "Позиция", wrap: true },
              { key: "unit", title: "Ед." },
              { key: "quantity", title: "Количество", mono: true, align: "right" },
              {
                key: "lineTotal",
                title: "Сумма",
                mono: true,
                align: "right",
                render: (row) => formatMoney(row.lineTotal, data.currency, i18n.language),
              },
            ]}
            rows={data.lines}
          />
        </div>
      </Card>
      <Card title="Документы" titleAs="h3">
        {downloadError ? <Alert tone="error">{downloadError}</Alert> : null}
        {data.documents.map((document) => (
          <div className="mk-billing-invoice-document" key={document.id}>
            <span>
              {document.format.toUpperCase()} · ревизия {document.revision} ·{" "}
              {document.status === "ready"
                ? "Готов"
                : document.status === "pending"
                  ? "Подготавливается"
                  : "Не удалось подготовить"}
            </span>
            {document.status === "ready" ? (
              <Button
                disabled={busy === document.id}
                loading={busy === document.id}
                onClick={() => handleDownload(document.id)}
              >
                Скачать
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
    </section>
  );
}
