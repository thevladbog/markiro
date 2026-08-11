import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input, PageHeader, StatusChip, Table } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { createInvoice, issueInvoice, listInvoices, payInvoice, renderInvoice, type Invoice } from "./api.js";

export function BillingPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  const invoices = useQuery({ queryKey: ["platform", "invoices"], queryFn: listInvoices });
  const [tenantId, setTenantId] = useState("");
  const [amount, setAmount] = useState("0.00");
  const [selected, setSelected] = useState<Invoice | null>(null);
  const create = useMutation({ mutationFn: () => createInvoice({ tenantId, applicationMode: "manual", lines: [{ kind: "custom", nameRu: "Услуга", nameEn: "Service", quantity: 1, unit: "шт", agreedUnitPrice: amount, vatIncluded: true }] }), onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "invoices"] }) });
  const issue = useMutation({ mutationFn: () => issueInvoice(selected!.id), onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "invoices"] }) });
  const pay = useMutation({ mutationFn: () => payInvoice(selected!.id, selected!.total, `manual-${selected!.number}`), onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "invoices"] }) });
  const document = useMutation({ mutationFn: () => renderInvoice(selected!.id) });
  if (invoices.isPending) return <section className="catalog-page"><PageHeader title={t("billing.title")} /><p>{t("billing.loading")}</p></section>;
  if (invoices.error) return <section className="catalog-page"><PageHeader title={t("billing.title")} /><Alert tone="error">{t("billing.loadError")}</Alert></section>;
  return <section className="catalog-page"><PageHeader title={t("billing.title")} />
    {principal.capabilities.includes("billing.write") ? <Card title={t("billing.newTitle")}><div style={{ display: "grid", gap: 10, maxWidth: 520 }}><Input label={t("billing.tenantId")} value={tenantId} onChange={(e) => setTenantId(e.target.value)} /><Input label={t("billing.amount")} value={amount} onChange={(e) => setAmount(e.target.value)} /><Button disabled={!tenantId || amount === "0.00"} loading={create.isPending} onClick={() => void create.mutateAsync()}>{t("billing.create")}</Button></div></Card> : null}
    <Table columns={[{ key: "number", title: t("billing.number"), render: (invoice: Invoice) => <button type="button" className="table-link" onClick={() => setSelected(invoice)}>{invoice.number}</button> }, { key: "tenant", title: t("billing.tenant"), render: (invoice: Invoice) => invoice.tenantId }, { key: "status", title: t("billing.status"), render: (invoice: Invoice) => <StatusChip status={invoice.status === "paid" ? "ok" : invoice.status === "cancelled" ? "neutral" : "warn"} label={invoice.status} /> }, { key: "total", title: t("billing.total") }]} rows={invoices.data?.items ?? []} empty={t("billing.empty")} />
    {selected ? <Card title={`${t("billing.detail")} · ${selected.number}`}><p>{selected.total} ₽</p><div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{selected.status === "draft" ? <Button loading={issue.isPending} onClick={() => void issue.mutateAsync()}>{t("billing.issue")}</Button> : null}{selected.status === "issued" ? <Button loading={pay.isPending} onClick={() => void pay.mutateAsync()}>{t("billing.pay")}</Button> : null}<Button loading={document.isPending} onClick={() => void document.mutateAsync()}>{t("billing.document")}</Button></div></Card> : null}
  </section>;
}
