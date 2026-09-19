import {
  Alert,
  Button,
  Select,
  Spinner,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listServicePeriods, type ServicePeriodList } from "./api.js";
import { ServicePeriodDrawer } from "./ServicePeriodDrawer.js";

type Row = ServicePeriodList["items"][number];

/**
 * Фактический union — `servicePeriodStateSchema`
 * (`packages/platform-contracts/src/service-periods.ts`): `upcoming` |
 * `active` | `expired`. По образцу `servicePeriodPhase` в
 * `apps/admin/src/pages/billing/format.ts`: предстоящий период ещё не
 * начался (`planned`, не вывод из оборота — там же был найден и исправлен
 * обратный дефект), завершённый — штатно закончен (`done`). Панель не
 * показывает остаток минут по периоду, поэтому уточнение `exhausted` из
 * кабинета здесь не переносится.
 */
const SERVICE_PERIOD_STATE_TO_PHASE = {
  upcoming: "planned",
  active: "active",
  expired: "done",
} as const satisfies Record<Row["state"], TagPhase>;
export function ServicePeriodsPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const [state, setState] = useState<"" | "upcoming" | "active" | "expired">("");
  const [selected, setSelected] = useState<string | null>(null);
  const filters = useMemo(() => ({ ...(state ? { state } : {}), limit: 50 }), [state]);
  const periods = useInfiniteQuery({
    queryKey: ["platform", "service-periods", filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listServicePeriods({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor,
  });
  useEffect(() => {
    if (periods.hasNextPage && !periods.isFetchingNextPage) void periods.fetchNextPage();
  }, [periods.fetchNextPage, periods.hasNextPage, periods.isFetchingNextPage]);
  const rows = periods.data?.pages.flatMap((page) => page.items) ?? [];
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      title: t("servicePeriods.columns.name"),
      render: (row) => (i18n.language.startsWith("ru") ? row.nameRu : row.nameEn),
    },
    {
      key: "period",
      title: t("servicePeriods.columns.period"),
      render: (row) =>
        `${new Date(row.startsAt).toLocaleDateString()} — ${new Date(row.endsAt).toLocaleDateString()}`,
    },
    {
      key: "balance",
      title: t("servicePeriods.columns.balance"),
      render: (row) =>
        `${row.balance.consumed} / ${row.balance.included + row.balance.externallyApproved}`,
    },
    {
      key: "state",
      title: t("servicePeriods.columns.state"),
      render: (row) => (
        <StatusChip
          phase={SERVICE_PERIOD_STATE_TO_PHASE[row.state]}
          label={t(`servicePeriods.state.${row.state}`)}
        />
      ),
    },
    {
      key: "actions",
      title: t("servicePeriods.columns.actions"),
      render: (row) => (
        <Button variant="secondary" onClick={() => setSelected(row.id)}>
          {t("servicePeriods.open")}
        </Button>
      ),
    },
  ];
  return (
    <section>
      <header className="page-header">
        <div>
          <p>{t("servicePeriods.eyebrow")}</p>
          <h1>{t("servicePeriods.title")}</h1>
          <p>{t("servicePeriods.description")}</p>
        </div>
      </header>
      <Select
        label={t("servicePeriods.stateFilter")}
        value={state}
        onValueChange={setState}
        options={[
          { value: "", label: t("servicePeriods.allStates") },
          { value: "active", label: t("servicePeriods.state.active") },
          { value: "upcoming", label: t("servicePeriods.state.upcoming") },
          { value: "expired", label: t("servicePeriods.state.expired") },
        ]}
      />
      {periods.isPending ? <Spinner label={t("servicePeriods.loading")} /> : null}
      {periods.isError ? <Alert tone="error">{t("servicePeriods.loadError")}</Alert> : null}
      {periods.data ? (
        <Table
          scrollLabel={t("servicePeriods.title")}
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          empty={t("servicePeriods.empty")}
        />
      ) : null}
      {selected ? (
        <ServicePeriodDrawer
          periodId={selected}
          canWriteUsage={principal.capabilities.includes("services.write")}
          canApprove={principal.capabilities.includes("billing.write")}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
