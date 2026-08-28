import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, Card, EmptyState, Spinner, Table } from "@markiro/ui";
import { downloadInvoice, useInvoice, useInvoices } from "./api.js";

export function InvoicesPage() {
  const { data, isPending, isError } = useInvoices();
  if (isPending) return <Spinner label="Загрузка счетов" />;
  if (isError) return <EmptyState title="Не удалось загрузить счета" />;
  if (!data?.items.length) return <EmptyState title="Счетов пока нет" />;
  return (
    <section aria-labelledby="billing-invoices-heading" className="mk-billing-invoices">
      <h2 className="mk-billing-section-heading" id="billing-invoices-heading">
        Счета
      </h2>
      <div className="mk-billing-table-wrap">
        <Table
          columns={[
            {
              key: "number",
              title: "Номер",
              render: (row) => <Link to={`/billing/invoices/${row.id}`}>{row.number}</Link>,
            },
            {
              key: "issueDate",
              title: "Дата",
              render: (row) =>
                row.issueDate ? new Date(row.issueDate).toLocaleDateString("ru-RU") : "—",
            },
            { key: "status", title: "Статус" },
            { key: "total", title: "Итого", render: (row) => `${row.total} ${row.currency}` },
          ]}
          rows={data.items}
        />
      </div>
    </section>
  );
}

export function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const { data, isPending, isError } = useInvoice(id);
  const [busy, setBusy] = useState<string | null>(null);
  const handleDownload = (documentId: string) => {
    void (async () => {
      setBusy(documentId);
      try {
        const result = await downloadInvoice(id, documentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } finally {
        setBusy(null);
      }
    })();
  };
  if (isPending) return <Spinner label="Загрузка счета" />;
  if (isError || !data) return <EmptyState title="Счет не найден" />;
  return (
    <section aria-labelledby="billing-invoice-heading" className="mk-billing-invoice-detail">
      <h2 className="mk-billing-section-heading" id="billing-invoice-heading">
        Счет {data.number}
      </h2>
      <Card title="Позиции">
        <div className="mk-billing-table-wrap">
          <Table
            columns={[
              { key: "position", title: "№" },
              { key: "nameRu", title: "Позиция" },
              { key: "unit", title: "Ед." },
              { key: "quantity", title: "Количество" },
              { key: "lineTotal", title: "Сумма" },
            ]}
            rows={data.lines}
          />
        </div>
        <p>
          Подытог: {data.subtotal} ₽ · НДС: {data.vatTotal} ₽ · Итого: {data.total} ₽
        </p>
      </Card>
      <Card title="Документы">
        {data.documents.map((document) => (
          <div className="mk-billing-invoice-document" key={document.id}>
            <span>
              {document.format.toUpperCase()} · ревизия {document.revision} · {document.status}
            </span>
            {document.status === "ready" ? (
              <Button disabled={busy === document.id} onClick={() => handleDownload(document.id)}>
                Скачать
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
    </section>
  );
}
