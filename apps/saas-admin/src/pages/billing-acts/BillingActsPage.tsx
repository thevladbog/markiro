import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, SectionHeader, StatusChip, Table } from "@markiro/ui";
import type { BillingAct } from "@markiro/platform-contracts";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listInvoices, type Invoice } from "../billing/api.js";
import { listBillingActs } from "./api.js";

export function BillingActsPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const acts = useQuery({
    queryKey: ["platform", "billing", "acts"],
    queryFn: listBillingActs,
  });
  const invoices = useQuery({ queryKey: ["platform", "invoices"], queryFn: listInvoices });
  const invoicesById = new Map(
    (invoices.data?.items ?? []).map((invoice) => [invoice.id, invoice]),
  );

  if (acts.error || invoices.error) {
    return (
      <section className="catalog-page">
        <h1>{t("billingActs.registry.title")}</h1>
        <Alert tone="error">{t("billingActs.registry.loadError")}</Alert>
      </section>
    );
  }

  return (
    <section className="catalog-page">
      <SectionHeader
        eyebrow="COMMERCE / ACTS"
        title={t("billingActs.registry.title")}
        description={t("billingActs.registry.description")}
        actionsLabel={t("billingActs.actions")}
        actions={
          principal.capabilities.includes("billing.write") ? (
            <Link to="/billing-acts/new">{t("billingActs.registry.create")}</Link>
          ) : null
        }
      />
      <section className="commerce-ledger" aria-labelledby="billing-acts-ledger-title">
        <header className="commerce-ledger__header">
          <div>
            <span className="commerce-ledger__eyebrow">CLOSING DOCUMENTS</span>
            <h2 id="billing-acts-ledger-title">{t("billingActs.registry.ledger")}</h2>
          </div>
          <span className="commerce-ledger__count">{acts.data?.items.length ?? 0}</span>
        </header>
        <Table
          columns={[
            {
              key: "number",
              title: t("billingActs.fields.number"),
              render: (act: BillingAct) => (
                <Link className="table-link" to={`/billing-acts/${act.id}`}>
                  {act.number}
                </Link>
              ),
            },
            {
              key: "tenant",
              title: t("billingActs.fields.tenant"),
              render: (act: BillingAct) => {
                const invoice = invoiceForAct(act, invoicesById);
                return invoice ? (
                  <Link className="table-link" to={`/tenants/${act.tenantId}`}>
                    {invoice.tenantName}
                  </Link>
                ) : (
                  t("billingActs.registry.unresolvedTenant")
                );
              },
            },
            {
              key: "invoice",
              title: t("billingActs.fields.invoice"),
              render: (act: BillingAct) => {
                const invoice = invoiceForAct(act, invoicesById);
                return invoice ? (
                  <Link className="table-link" to={`/invoices/${invoice.id}`}>
                    {invoice.number}
                  </Link>
                ) : (
                  t("billingActs.registry.withoutInvoice")
                );
              },
            },
            {
              key: "period",
              title: t("billingActs.registry.period"),
              render: (act: BillingAct) => `${act.periodStart} — ${act.periodEnd}`,
            },
            {
              key: "status",
              title: t("billingActs.detail.status"),
              render: (act: BillingAct) => (
                <StatusChip
                  status={
                    act.status === "issued" ? "ok" : act.status === "draft" ? "warn" : "neutral"
                  }
                  label={t(`billingActs.status.${act.status}`)}
                />
              ),
            },
          ]}
          rows={acts.data?.items ?? []}
          empty={
            acts.isPending || invoices.isPending
              ? t("billingActs.registry.loading")
              : t("billingActs.registry.empty")
          }
        />
      </section>
    </section>
  );
}

function invoiceForAct(act: BillingAct, invoices: Map<string, Invoice>): Invoice | undefined {
  return act.invoiceId ? invoices.get(act.invoiceId) : undefined;
}
