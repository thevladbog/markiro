import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { Alert, PageHeader, StatusChip, Table } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listInvoices, type Invoice } from "./api.js";

export function BillingPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const invoices = useQuery({ queryKey: ["platform", "invoices"], queryFn: listInvoices });
  const location = useLocation();
  if (invoices.isPending)
    return (
      <section className="catalog-page">
        <PageHeader title={t("billing.title")} />
        <p>{t("billing.loading")}</p>
      </section>
    );
  if (invoices.error)
    return (
      <section className="catalog-page">
        <PageHeader title={t("billing.title")} />
        <Alert tone="error">{t("billing.loadError")}</Alert>
      </section>
    );
  return (
    <section className="catalog-page">
      <PageHeader
        title={t("billing.title")}
        actions={
          <span className="billing-header-actions">
            <Link to="/payments">{t("payments.open")}</Link>
            {principal.capabilities.includes("billing.write") ? (
              <Link to="/invoices/new">{t("billing.create")}</Link>
            ) : null}
          </span>
        }
      />
      {(location.state as { createdDocument?: unknown } | null)?.createdDocument === "invoice" ? (
        <Alert tone="ok">{t("billing.created")}</Alert>
      ) : null}
      <Table
        columns={[
          {
            key: "number",
            title: t("billing.number"),
            render: (invoice: Invoice) => (
              <Link className="table-link" to={`/invoices/${invoice.id}`}>
                {invoice.number}
              </Link>
            ),
          },
          {
            key: "tenant",
            title: t("billing.tenant"),
            render: (invoice: Invoice) => invoice.tenantId,
          },
          {
            key: "status",
            title: t("billing.status"),
            render: (invoice: Invoice) => (
              <StatusChip
                status={
                  invoice.status === "paid"
                    ? "ok"
                    : invoice.status === "cancelled"
                      ? "neutral"
                      : "warn"
                }
                label={invoice.status}
              />
            ),
          },
          { key: "total", title: t("billing.total") },
        ]}
        rows={invoices.data?.items ?? []}
        empty={t("billing.empty")}
      />
    </section>
  );
}
