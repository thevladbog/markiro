import { useMemo, useState } from "react";

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

function documentStatusLabel(status: TenantDocument["status"]): string {
  return { ready: "Готов", pending: "Подготавливается", failed: "Не удалось подготовить" }[status];
}

export function DocumentsPage() {
  const [filters, setFilters] = useState<DocumentFilters>({});
  const [status, setStatus] = useState<DocumentStatusFilter>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
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
      setDownloadError(null);
      try {
        const result =
          document.type === "offer"
            ? await downloadOfferDocument(document.entityId, document.id)
            : await downloadActDocument(document.entityId, document.id);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError("Не удалось скачать документ. Повторите попытку позже.");
      } finally {
        setBusy(null);
      }
    })();
  if (isPending) return <Spinner label="Загрузка документов" />;
  if (isError) return <EmptyState title="Не удалось загрузить документы" />;
  return (
    <section aria-labelledby="billing-documents-heading" className="mk-billing-documents">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-documents-heading">
            Документы
          </h2>
          <p>Акты и коммерческие предложения доступны, когда Markiro подготовил файл.</p>
        </div>
        <div className="mk-billing-filters" role="group" aria-label="Фильтры документов">
          <Select
            native
            label="Тип документа"
            value={filters.type ?? ""}
            onValueChange={(type) => setFilters(type ? { ...filters, type } : clear("type"))}
            options={[
              { value: "", label: "Все типы" },
              { value: "offer", label: "Предложения" },
              { value: "act", label: "Акты" },
            ]}
          />
          <Select
            native
            label="Статус документа"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: "", label: "Все статусы" },
              { value: "ready", label: "Готов" },
              { value: "pending", label: "Подготавливается" },
              { value: "failed", label: "Не удалось подготовить" },
            ]}
          />
          <Input
            label="С даты"
            type="date"
            value={filters.from ?? ""}
            onChange={(event) =>
              setFilters(
                event.target.value ? { ...filters, from: event.target.value } : clear("from"),
              )
            }
          />
          <Input
            label="По дату"
            type="date"
            value={filters.to ?? ""}
            onChange={(event) =>
              setFilters(event.target.value ? { ...filters, to: event.target.value } : clear("to"))
            }
          />
        </div>
      </div>
      {downloadError ? <Alert tone="error">{downloadError}</Alert> : null}
      {documents.length === 0 ? (
        <EmptyState title="Документы по выбранным фильтрам не найдены" />
      ) : (
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel="Реестр документов"
            columns={[
              {
                key: "type",
                title: "Тип",
                render: (row) => (row.type === "offer" ? "Коммерческое предложение" : "Акт"),
              },
              {
                key: "createdAt",
                title: "Дата",
                render: (row) => formatBillingDate(row.createdAt, "ru-RU"),
              },
              { key: "revision", title: "Ревизия", mono: true },
              {
                key: "status",
                title: "Состояние",
                render: (row) => documentStatusLabel(row.status),
              },
              {
                key: "download",
                title: "Файл",
                render: (row) =>
                  row.status === "ready" ? (
                    <Button
                      disabled={busy === row.id}
                      loading={busy === row.id}
                      onClick={() => download(row)}
                    >
                      Скачать
                    </Button>
                  ) : (
                    <span>{documentStatusLabel(row.status)}</span>
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
