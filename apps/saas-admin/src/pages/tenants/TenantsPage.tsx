import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import {
  Alert,
  Button,
  Card,
  EmptyState,
  FilterBar,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
  type SelectOption,
  type TableColumn,
} from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listTenants, type TenantListItem, type TenantSubscriptionStatus } from "./api.js";

type StatusFilter = "all" | TenantSubscriptionStatus;

const STATUS_TONE = {
  pending_activation: "warn",
  scheduled: "info",
  trial: "info",
  active: "ok",
  expired: "error",
  superseded: "neutral",
  cancelled: "neutral",
  unmanaged: "warn",
} as const;

export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const limit = 50;
  const tenants = useQuery({
    queryKey: ["platform", "tenants", page, status],
    queryFn: () => listTenants({ page, limit, ...(status === "all" ? {} : { status }) }),
  });
  const normalizedSearch = search.trim().toLocaleLowerCase(i18n.resolvedLanguage ?? "ru");
  const visibleItems = useMemo(
    () =>
      (tenants.data?.items ?? []).filter((item) => {
        if (!normalizedSearch) return true;
        return `${item.name} ${item.slug}`
          .toLocaleLowerCase(i18n.resolvedLanguage ?? "ru")
          .includes(normalizedSearch);
      }),
    [i18n.resolvedLanguage, normalizedSearch, tenants.data?.items],
  );
  const canCreate =
    principal.role !== "accountant" && principal.capabilities.includes("tenants.write");
  const financialVisible = principal.role !== "support";
  const language = i18n.resolvedLanguage?.startsWith("en") ? "en" : "ru";
  const money = useMemo(
    () =>
      new Intl.NumberFormat(language === "en" ? "en-GB" : "ru-RU", {
        style: "currency",
        currency: "RUB",
        minimumFractionDigits: 2,
      }),
    [language],
  );

  const columns = useMemo<TableColumn<TenantListItem>[]>(
    () => [
      {
        key: "name",
        title: t("tenants.columns.tenant"),
        render: (item) => (
          <Link className="tenant-table-link" to={`/tenants/${item.id}`}>
            <span>{item.name}</span>
            <small>{item.slug}</small>
          </Link>
        ),
      },
      {
        key: "subscriptionStatus",
        title: t("tenants.columns.status"),
        render: (item) => (
          <StatusChip
            status={STATUS_TONE[item.subscriptionStatus]}
            label={t(`tenants.status.${item.subscriptionStatus}`)}
          />
        ),
      },
      {
        key: "plan",
        title: t("tenants.columns.plan"),
        render: (item) => {
          const plan = item.subscription?.planVersion;
          if (!plan?.id || !plan.version) return t("tenants.noPlan");
          const name = language === "en" ? plan.nameEn : plan.nameRu;
          return (
            <span className="tenant-plan-cell">
              <span>{name ?? t("tenants.unknownPlan")}</span>
              <small>{t("tenants.version", { version: plan.version })}</small>
            </span>
          );
        },
      },
      {
        key: "endsAt",
        title: t("tenants.columns.endsAt"),
        mono: true,
        render: (item) =>
          item.subscription?.endsAt
            ? new Intl.DateTimeFormat(language === "en" ? "en-GB" : "ru-RU", {
                dateStyle: "medium",
                timeZone: "Europe/Moscow",
              }).format(new Date(item.subscription.endsAt))
            : "—",
      },
      ...(financialVisible
        ? [
            {
              key: "price",
              title: t("tenants.columns.price"),
              align: "right" as const,
              mono: true,
              render: (item: TenantListItem) => {
                const price = item.subscription?.planVersion.unitPrice;
                return price ? money.format(Number(price)) : "—";
              },
            },
          ]
        : []),
    ],
    [financialVisible, language, money, t],
  );

  const statusOptions: SelectOption<StatusFilter>[] = [
    { value: "all", label: t("tenants.filters.all") },
    ...(
      [
        "pending_activation",
        "trial",
        "active",
        "scheduled",
        "expired",
        "superseded",
        "cancelled",
        "unmanaged",
      ] as const
    ).map((value) => ({ value, label: t(`tenants.status.${value}`) })),
  ];
  const pageCount = Math.max(1, Math.ceil((tenants.data?.total ?? 0) / limit));

  return (
    <section className="tenants-page">
      <PageHeader
        title={t("tenants.title")}
        actions={
          canCreate ? (
            <Button onClick={() => void navigate("/tenants/new")}>{t("tenants.create")}</Button>
          ) : null
        }
      />
      <div className="catalog-coordinate" aria-hidden="true">
        TENANTS / SUBSCRIPTION CONTROL
      </div>
      <FilterBar
        label={t("tenants.filters.label")}
        resultSummary={
          tenants.data
            ? t("tenants.filters.result", {
                count: visibleItems.length,
                pageCount: tenants.data.items.length,
                total: tenants.data.total,
              })
            : ""
        }
      >
        <Input
          className="tenant-search"
          label={t("tenants.filters.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          native
          className="tenant-status-filter"
          label={t("tenants.filters.status")}
          options={statusOptions}
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
      </FilterBar>
      <p className="tenant-search-scope">{t("tenants.filters.pageScope")}</p>
      {tenants.isPending ? (
        <div className="tenant-list-state" role="status">
          <Spinner label={t("tenants.loading")} />
        </div>
      ) : tenants.error ? (
        <Alert tone="error">{t("tenants.loadError")}</Alert>
      ) : tenants.data.items.length === 0 ? (
        <Card padding={0}>
          <EmptyState
            title={t(
              status === "all" && tenants.data.total === 0
                ? "tenants.empty.title"
                : "tenants.filteredEmpty.title",
            )}
            hint={t(
              status === "all" && tenants.data.total === 0
                ? "tenants.empty.hint"
                : "tenants.filteredEmpty.hint",
            )}
            action={
              status === "all" && tenants.data.total === 0 && canCreate ? (
                <Button onClick={() => void navigate("/tenants/new")}>{t("tenants.create")}</Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <>
          <Card className="tenant-table-card" padding={0}>
            <Table
              columns={columns}
              rows={visibleItems}
              empty={t("tenants.noMatchesOnPage")}
              scrollLabel={t("tenants.tableRegion")}
            />
          </Card>
          {pageCount > 1 ? (
            <nav className="tenant-pagination" aria-label={t("tenants.pagination.label")}>
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                {t("tenants.pagination.previous")}
              </Button>
              <span aria-live="polite">{t("tenants.pagination.page", { page, pageCount })}</span>
              <Button
                variant="secondary"
                disabled={page >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >
                {t("tenants.pagination.next")}
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
