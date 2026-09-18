import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { formatSsccHri } from "@markiro/domain";
import {
  Alert,
  Badge,
  Button,
  DatePicker,
  EmptyState,
  PageHeader,
  Select,
  Spinner,
  Table,
} from "@markiro/ui";
import type { SelectOption, TableColumn } from "@markiro/ui";

import { formatCreatedAt } from "../../lib/datetime.js";
import { useProducts } from "../catalog/api.js";
import { RegistryTabs } from "../code-search/RegistryTabs.js";
import { useAllDevices } from "../devices/api.js";
import {
  useInfinitePallets,
  type PalletDto,
  type PalletKind,
  type PalletListFilters,
} from "../shifts/pallets-api.js";

const ALL = "all";

type KindFilter = PalletKind | typeof ALL;

/**
 * The manager picks civil days in the browser's own zone; the server filters
 * on `closed_at` instants. A day starts at local midnight and ends at the last
 * millisecond of that local day, so «с 17.09 по 17.09» means the whole of the
 * 17th where the manager sits, not a UTC day that may straddle two local ones.
 */
function dayStartIso(civilDate: string): string {
  return new Date(`${civilDate}T00:00:00`).toISOString();
}

function dayEndIso(civilDate: string): string {
  return new Date(`${civilDate}T23:59:59.999`).toISOString();
}

/**
 * Org-wide pallet registry (warehouse pallets, plan 3): the third tab of the
 * code-search section. Unlike the shift panel's list (`usePallets(shiftId)`),
 * this one spans every shift and every warehouse pallet of the tenant, so it
 * is paged by the server's cursor and grown with «Показать ещё» rather than
 * fetched whole.
 */
export function PalletsPage() {
  const { t, i18n } = useTranslation();

  const [kind, setKind] = useState<KindFilter>(ALL);
  const [productId, setProductId] = useState<string>(ALL);
  const [deviceId, setDeviceId] = useState<string>(ALL);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);

  const filters = useMemo<PalletListFilters>(
    () => ({
      ...(kind !== ALL ? { kind } : {}),
      ...(productId !== ALL ? { productId } : {}),
      ...(deviceId !== ALL ? { deviceId } : {}),
      ...(from ? { closedFrom: dayStartIso(from) } : {}),
      ...(to ? { closedTo: dayEndIso(to) } : {}),
    }),
    [kind, productId, deviceId, from, to],
  );

  const query = useInfinitePallets(filters);
  const { data: products } = useProducts({ archived: "all" });
  const { data: devices } = useAllDevices();

  const kindOptions: SelectOption[] = [
    { value: ALL, label: t("pages.pallets.filters.kindAll") },
    { value: "production", label: t("pages.pallets.filters.kindProduction") },
    { value: "warehouse", label: t("pages.pallets.filters.kindWarehouse") },
  ];
  const productOptions: SelectOption[] = useMemo(
    () => [
      { value: ALL, label: t("pages.pallets.filters.productAll") },
      ...(products ?? []).map((product) => ({ value: product.id, label: product.name })),
    ],
    [products, t],
  );
  const deviceOptions: SelectOption[] = useMemo(
    () => [
      { value: ALL, label: t("pages.pallets.filters.deviceAll") },
      ...(devices ?? []).map((device) => ({ value: device.id, label: device.name })),
    ],
    [devices, t],
  );

  const columns: TableColumn<PalletDto>[] = useMemo(
    () => [
      {
        key: "sscc",
        title: t("pages.pallets.table.sscc"),
        mono: true,
        render: (row) => (
          <Link to={`/codes/pallet/${row.id}`}>
            {row.sscc ? formatSsccHri(row.sscc) : t("pages.pallets.noSscc")}
          </Link>
        ),
      },
      {
        key: "kind",
        title: t("pages.pallets.table.kind"),
        render: (row) => (
          <Badge tone={row.kind === "warehouse" ? "accent" : "neutral"}>
            {t(`pages.pallets.kind.${row.kind}`)}
          </Badge>
        ),
      },
      {
        key: "productName",
        title: t("pages.pallets.table.product"),
        wrap: true,
        render: (row) => row.productName ?? "—",
      },
      {
        key: "deviceName",
        title: t("pages.pallets.table.device"),
        render: (row) => row.deviceName ?? "—",
      },
      {
        key: "boxCount",
        title: t("pages.pallets.table.boxCount"),
        align: "right",
        mono: true,
        render: (row) => new Intl.NumberFormat(i18n.language).format(row.boxCount),
      },
      {
        key: "unitCount",
        title: t("pages.pallets.table.unitCount"),
        align: "right",
        mono: true,
        render: (row) => new Intl.NumberFormat(i18n.language).format(row.unitCount),
      },
      {
        key: "closedAt",
        title: t("pages.pallets.table.closedAt"),
        render: (row) => (row.closedAt ? formatCreatedAt(row.closedAt, i18n.language) : "—"),
      },
      {
        key: "status",
        title: t("pages.pallets.table.status"),
        wrap: true,
        // Three independent facts, each its own badge with text (never colour
        // alone): taken apart, short a box after closing, and how many boxes
        // the server refused to put on it.
        render: (row) => (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {row.disassembledAt ? (
              <Badge tone="neutral">{t("pages.pallets.disassembled")}</Badge>
            ) : null}
            {row.contentsChangedAfterClose ? (
              <Badge tone="warn">{t("pages.pallets.contentsChangedAfterClose")}</Badge>
            ) : null}
            {row.rejectedMembershipCount > 0 ? (
              <Badge tone="error">
                {t("pages.pallets.rejections", {
                  count: new Intl.NumberFormat(i18n.language).format(row.rejectedMembershipCount),
                })}
              </Badge>
            ) : null}
          </span>
        ),
      },
    ],
    [t, i18n.language],
  );

  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader title={t("pages.codeSearch.title")} />

      <RegistryTabs active="pallets" />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ width: 200 }}>
          <Select
            label={t("pages.pallets.filters.kindLabel")}
            options={kindOptions}
            value={kind}
            onValueChange={(value) => setKind(value as KindFilter)}
          />
        </div>
        <div style={{ width: "min(100%, 320px)" }}>
          <Select
            label={t("pages.pallets.filters.productLabel")}
            options={productOptions}
            value={productId}
            onValueChange={setProductId}
            searchable
            searchLabel={t("pages.pallets.filters.productSearchLabel")}
          />
        </div>
        <div style={{ width: "min(100%, 260px)" }}>
          <Select
            label={t("pages.pallets.filters.deviceLabel")}
            options={deviceOptions}
            value={deviceId}
            onValueChange={setDeviceId}
            searchable
            searchLabel={t("pages.pallets.filters.deviceSearchLabel")}
          />
        </div>
        <DatePicker
          label={t("pages.pallets.filters.fromLabel")}
          placeholder={t("common.datePicker.placeholder")}
          clearLabel={t("common.datePicker.clear")}
          calendarLabel={t("common.datePicker.calendar")}
          previousMonthLabel={t("common.datePicker.previousMonth")}
          nextMonthLabel={t("common.datePicker.nextMonth")}
          locale={i18n.language}
          {...(from !== undefined ? { value: from } : {})}
          onValueChange={setFrom}
        />
        <DatePicker
          label={t("pages.pallets.filters.toLabel")}
          placeholder={t("common.datePicker.placeholder")}
          clearLabel={t("common.datePicker.clear")}
          calendarLabel={t("common.datePicker.calendar")}
          previousMonthLabel={t("common.datePicker.previousMonth")}
          nextMonthLabel={t("common.datePicker.nextMonth")}
          locale={i18n.language}
          {...(to !== undefined ? { value: to } : {})}
          onValueChange={setTo}
        />
      </div>

      {query.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : query.isError ? (
        <Alert tone="error">{t("common.loadError")}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title={t("pages.pallets.empty")} />
      ) : (
        <>
          <Table
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            scrollLabel={t("pages.pallets.title")}
          />
          {query.hasNextPage ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("pages.pallets.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
