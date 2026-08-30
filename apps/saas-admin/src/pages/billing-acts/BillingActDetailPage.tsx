import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { Alert, SectionHeader, Spinner, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { getBillingRequest } from "../billing-requests/api.js";
import { getInvoice } from "../billing/api.js";
import { getBillingAct } from "./api.js";

export function BillingActDetailPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const { actId } = useParams();
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
  return (
    <section className="catalog-page billing-act-detail">
      <SectionHeader
        eyebrow="COMMERCE / ACTS / DETAIL"
        title={act.number}
        description={t("billingActs.detail.description")}
        actionsLabel={t("billingActs.actions")}
        actions={
          act.requestId ? (
            <Link to={`/billing-requests/${act.requestId}`}>
              {request.data?.number ?? t("billingActs.detail.openRequest")}
            </Link>
          ) : (
            <Link to="/billing-acts">{t("billingActs.backToRegistry")}</Link>
          )
        }
      />
      <dl className="billing-request-facts">
        <div>
          <dt>{t("billingActs.detail.status")}</dt>
          <dd>
            <StatusChip
              status={act.status === "issued" ? "ok" : act.status === "draft" ? "warn" : "neutral"}
              label={t(`billingActs.status.${act.status}`)}
            />
          </dd>
        </div>
        <div>
          <dt>{t("billingActs.fields.periodStart")}</dt>
          <dd>{act.periodStart}</dd>
        </div>
        <div>
          <dt>{t("billingActs.fields.periodEnd")}</dt>
          <dd>{act.periodEnd}</dd>
        </div>
        {act.document ? (
          <div>
            <dt>{t("billingActs.detail.printVariant")}</dt>
            <dd>{t(`billingActs.print.variant.${act.document.printVariant}`)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("billingActs.fields.tenant")}</dt>
          <dd>
            <Link to={`/tenants/${act.tenantId}`}>
              {invoice.data?.tenantName ?? t("billingActs.detail.openTenant")}
            </Link>
          </dd>
        </div>
      </dl>
      {act.invoiceId ? (
        <div className="billing-request-actions">
          <Link to={`/invoices/${act.invoiceId}`}>
            {invoice.data?.number ?? t("billingActs.detail.openInvoice")}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
