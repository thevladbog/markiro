import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Button, EmptyState, Select, Spinner, Table } from "@markiro/ui";

import { BillingStatusChip } from "./BillingSections.js";
import {
  type BillingRequestFilters,
  type BillingRequestStatus,
  type TenantBillingRequest,
  useBillingRequests,
} from "./api.js";
import { formatBillingDate } from "./format.js";
import { BILLING_REQUEST_TYPES } from "./requestForm.js";

const REQUEST_STATUSES: BillingRequestStatus[] = [
  "new",
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
];

function RequestFilters({
  filters,
  onChange,
}: {
  filters: BillingRequestFilters;
  onChange: (filters: BillingRequestFilters) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="mk-billing-filters mk-billing-request-filters"
      role="group"
      aria-label={t("pages.billing.requests.filters.label")}
    >
      <Select
        native
        label={t("pages.billing.requests.filters.status")}
        value={filters.status ?? ""}
        onValueChange={(status) =>
          onChange({
            ...(status ? { status } : {}),
            ...(filters.type ? { type: filters.type } : {}),
          })
        }
        options={[
          { value: "", label: t("pages.billing.requests.filters.allStatuses") },
          ...REQUEST_STATUSES.map((status) => ({
            value: status,
            label: t(`pages.billing.status.request.${status}`),
          })),
        ]}
      />
      <Select
        native
        label={t("pages.billing.requests.filters.type")}
        value={filters.type ?? ""}
        onValueChange={(type) =>
          onChange({
            ...(filters.status ? { status: filters.status } : {}),
            ...(type ? { type } : {}),
          })
        }
        options={[
          { value: "", label: t("pages.billing.requests.filters.allTypes") },
          ...BILLING_REQUEST_TYPES.map((type) => ({
            value: type,
            label: t(`pages.billing.requests.types.${type}`),
          })),
        ]}
      />
      <Button
        variant="secondary"
        disabled={!filters.status && !filters.type}
        onClick={() => onChange({})}
      >
        {t("pages.billing.requests.filters.clear")}
      </Button>
    </div>
  );
}

function RequestNumber({ request }: { request: TenantBillingRequest }) {
  return <Link to={`/billing/requests/${request.id}`}>{request.number}</Link>;
}

export function RequestsPage() {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useState<BillingRequestFilters>({});
  const query = useBillingRequests(filters);
  if (query.isPending) return <Spinner label={t("pages.billing.requests.loading")} />;
  if (query.isError) {
    return (
      <EmptyState
        title={t("pages.billing.requests.loadError")}
        action={<Button onClick={() => void query.refetch()}>{t("pages.billing.retry")}</Button>}
      />
    );
  }
  const items = (query.data?.items ?? []).filter(
    (request) =>
      (!filters.status || request.status === filters.status) &&
      (!filters.type || request.type === filters.type),
  );
  return (
    <section className="mk-billing-requests" aria-labelledby="billing-requests-heading">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-requests-heading">
            {t("pages.billing.requests.heading")}
          </h2>
          <p>{t("pages.billing.requests.description")}</p>
        </div>
        <RequestFilters filters={filters} onChange={setFilters} />
      </div>
      {items.length === 0 ? (
        <EmptyState title={t("pages.billing.requests.empty")} />
      ) : (
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel={t("pages.billing.requests.registry")}
            columns={[
              {
                key: "number",
                title: t("pages.billing.requests.columns.number"),
                render: (row) => <RequestNumber request={row} />,
              },
              {
                key: "type",
                title: t("pages.billing.requests.columns.type"),
                wrap: true,
                render: (row) => t(`pages.billing.requests.types.${row.type}`),
              },
              {
                key: "status",
                title: t("pages.billing.requests.columns.status"),
                render: (row) => <BillingStatusChip kind="request" value={row.status} />,
              },
              {
                key: "responsibleSide",
                title: t("pages.billing.requests.columns.responsible"),
                render: (row) => t(`pages.billing.requests.responsible.${row.responsibleSide}`),
              },
              {
                key: "updatedAt",
                title: t("pages.billing.requests.columns.updated"),
                render: (row) => formatBillingDate(row.updatedAt, i18n.language),
              },
            ]}
            rows={items}
          />
        </div>
      )}
    </section>
  );
}
