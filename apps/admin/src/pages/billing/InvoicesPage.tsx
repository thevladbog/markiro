import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, Card, EmptyState, PageHeader, Spinner, Table } from "@markiro/ui";
import { downloadInvoice, useInvoice, useInvoices } from "./api.js";

export function InvoicesPage() {
  const { data, isPending, isError } = useInvoices();
  if (isPending) return <Spinner label="Загрузка счетов" />;
  if (isError) return <EmptyState title="Не удалось загрузить счета" />;
  if (!data?.items.length) return <EmptyState title="Счетов пока нет" />;
  return (
    <div style={{ padding: "28px 32px" }}>
      <PageHeader title="Счета" />
      <div style={{ overflowX: "auto" }}>
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
    </div>
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
    <div style={{ padding: "28px 32px" }}>
      <PageHeader title={`Счет ${data.number}`} />
      <Card title="Позиции">
        <div style={{ overflowX: "auto" }}>
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
          <div
            key={document.id}
            style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}
          >
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
    </div>
  );
}
