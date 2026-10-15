import { classifyScan } from "@markiro/domain";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";

import {
  Button,
  Card,
  DatePicker,
  EmptyState,
  FilterBar,
  Input,
  PageHeader,
  Select,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { OfficePalletRow } from "../../host/pack-cards.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeInfiniteQuery, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { activeFirstByName } from "../records.js";
import { searchableSelect } from "../select-search.js";
import { PalletCountTag } from "../shifts/PalletCountTag.js";
import { packState } from "../shifts/shift-card.js";
import { datePickerTexts } from "../shifts/shift-text.js";
import { instantFormat, ShiftLink } from "./CodeCard.js";
import { PackStateChip, PalletLinkOrOpen } from "./PackLinks.js";
import {
  EMPTY_PALLET_FILTERS,
  palletFiltersOf,
  palletListQuery,
  paramsOfPalletFilters,
  type PalletFilters,
} from "./pallet-query.js";
import { RegistryTabs } from "./RegistryTabs.js";

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

/**
 * «Паллеты» (plan КРТ, the cloud's pallet list): every pallet of the site,
 * open ones first, then by closing from the newest, narrowed by product,
 * line, station, the days of closing and an SSCC; a page of 100 at a time
 * with «Показать ещё». The filters live in the address, so «Назад» from a
 * pallet's card finds the list as it was. A row opens the pallet's card.
 */
export function PalletsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = palletFiltersOf(params);
  const [ssccText, setSsccText] = useState(filters.sscc);
  const [ssccError, setSsccError] = useState(false);
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const products = useOfficeQuery(officeKeys.products, (api, token) => api.listProducts(token));
  const lines = useOfficeQuery(officeKeys.lines, (api, token) => api.listLines(token));
  // The days of a period are the site's: the list waits for its zone.
  const zoneReady = !org.isPending;
  const zone = formTimeZone(org.data);
  const format = instantFormat(zone);
  const query = palletListQuery(filters, zone);
  const pages = useOfficeInfiniteQuery(
    officeKeys.palletList(query ?? {}),
    (api, token, cursor) => api.listPallets(token, query ?? {}, cursor),
    (page) => page.nextCursor,
    { enabled: zoneReady && query !== null },
  );
  // A query that cannot be asked (a backwards period) shows nothing of what an earlier one cached.
  const listed = query !== null && pages.data !== undefined;
  const rows = useMemo(
    () => (listed ? (pages.data?.pages.flatMap((page) => page.items) ?? []) : []),
    [listed, pages.data],
  );
  const stations = pages.data?.pages[0]?.stations ?? [];
  const periodError = filters.from !== "" && filters.to !== "" && filters.to < filters.from;

  const apply = (change: Partial<PalletFilters>) => {
    setParams(paramsOfPalletFilters({ ...filters, ...change }));
  };
  const submitSscc = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const typed = ssccText.trim();
    if (typed === "") {
      setSsccError(false);
      apply({ sscc: "" });
      return;
    }
    // A scanned label comes with its AI and the scanner's prefix; a pallet's SSCC starts with 1.
    const scan = classifyScan(typed);
    if (scan.kind === "sscc" && scan.sscc.startsWith("1")) {
      setSsccError(false);
      setSsccText(scan.sscc);
      apply({ sscc: scan.sscc });
    } else {
      setSsccError(true);
    }
  };
  const reset = () => {
    setSsccText("");
    setSsccError(false);
    setParams(paramsOfPalletFilters(EMPTY_PALLET_FILTERS));
  };

  const columns: TableColumn<OfficePalletRow>[] = [
    {
      key: "sscc",
      title: t("office.palletList.table.sscc"),
      mono: true,
      render: (pallet) => <PalletLinkOrOpen id={pallet.id} sscc={pallet.sscc} />,
    },
    {
      key: "state",
      title: t("office.palletList.table.state"),
      wrap: true,
      minWidth: 200,
      render: (pallet) => (
        <span className="shift-cell">
          <PackStateChip state={packState(pallet)} kind="pallet" />
          {pallet.disassembledAt !== null && (
            <span className="shift-cell__quiet">
              {t("office.palletList.disassembledAt", { at: format(pallet.disassembledAt) })}
            </span>
          )}
          <PalletCountTag pallet={pallet} differsLabel={t("office.palletList.changedAfterClose")} />
        </span>
      ),
    },
    { key: "productName", title: t("office.palletList.table.product"), wrap: true, minWidth: 120 },
    {
      key: "shift",
      title: t("office.palletList.table.shift"),
      render: (pallet) => (
        <ShiftLink item={{ shiftId: pallet.shiftId, shiftNumber: pallet.shiftNumber }} />
      ),
    },
    { key: "lineName", title: t("office.palletList.table.line"), wrap: true, minWidth: 80 },
    { key: "deviceName", title: t("office.palletList.table.station"), wrap: true, minWidth: 110 },
    {
      key: "boxes",
      title: t("office.palletList.table.boxes"),
      mono: true,
      align: "right",
      render: (pallet) =>
        packState(pallet) === "disassembled" ? t("office.common.none") : COUNT.format(pallet.boxes),
    },
    {
      key: "units",
      title: t("office.palletList.table.units"),
      mono: true,
      align: "right",
      render: (pallet) =>
        packState(pallet) === "disassembled" ? t("office.common.none") : COUNT.format(pallet.units),
    },
    {
      key: "closedAt",
      title: t("office.palletList.table.closedAt"),
      wrap: true,
      minWidth: 150,
      render: (pallet) =>
        pallet.closedAt === null ? t("office.common.none") : format(pallet.closedAt),
    },
  ];

  const content = () => {
    if (query === null) return null;
    if (pages.isPending || pages.isPlaceholderData) return <PageLoading />;
    if (pages.isError && pages.data === undefined)
      return <LoadError error={pages.error} onRetry={() => void pages.refetch()} />;
    if (rows.length === 0) return <EmptyState title={t("office.palletList.empty")} />;
    return (
      <Card>
        <Table
          columns={columns}
          rows={rows}
          getRowKey={(pallet) => pallet.id}
          onRowClick={(pallet) => void navigate(`/codes/pallet/${pallet.id}`)}
          scrollLabel={t("office.palletList.table.label")}
        />
        {pages.isFetchNextPageError && (
          <LoadError error={pages.error} onRetry={() => void pages.fetchNextPage()} />
        )}
        {pages.hasNextPage && (
          <Button
            variant="secondary"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {t("office.palletList.loadMore")}
          </Button>
        )}
      </Card>
    );
  };

  return (
    <div className="office-stack">
      <PageHeader title={t("office.codeSearch.title")} />
      <RegistryTabs active="pallets" />
      <form
        role="search"
        aria-label={t("office.palletList.filters")}
        onSubmit={submitSscc}
        noValidate
      >
        <FilterBar
          label={t("office.palletList.filters")}
          resultSummary={
            pages.isSuccess
              ? t("office.palletList.shown", { shown: COUNT.format(rows.length) })
              : ""
          }
        >
          <Select
            {...searchableSelect(t)}
            searchLabel={t("office.palletList.productSearch")}
            label={t("office.palletList.product")}
            options={[
              { value: "", label: t("office.palletList.allProducts") },
              ...activeFirstByName(products.data ?? []).map((product) => ({
                value: product.id,
                label: product.archived
                  ? t("office.common.archivedName", { name: product.name })
                  : product.name,
              })),
            ]}
            value={filters.product}
            onValueChange={(product) => apply({ product })}
          />
          <Select
            {...searchableSelect(t)}
            label={t("office.palletList.line")}
            options={[
              { value: "", label: t("office.palletList.allLines") },
              ...activeFirstByName(lines.data ?? []).map((line) => ({
                value: line.id,
                label: line.archived
                  ? t("office.common.archivedName", { name: line.name })
                  : line.name,
              })),
            ]}
            value={filters.line}
            onValueChange={(line) => apply({ line })}
          />
          <Select
            label={t("office.palletList.station")}
            options={[
              { value: "", label: t("office.palletList.allStations") },
              ...stations.map((station) => ({
                value: station.id,
                label: station.revoked
                  ? t("office.palletList.revokedStation", { name: station.name })
                  : station.name,
              })),
            ]}
            value={filters.device}
            onValueChange={(device) => apply({ device })}
          />
          <DatePicker
            label={t("office.palletList.from")}
            {...datePickerTexts(t)}
            {...(filters.from === "" ? {} : { value: filters.from })}
            onValueChange={(value) => apply({ from: value ?? "" })}
          />
          <DatePicker
            label={t("office.palletList.to")}
            {...datePickerTexts(t)}
            {...(filters.to === "" ? {} : { value: filters.to })}
            {...(periodError ? { error: t("office.palletList.periodBackwards") } : {})}
            onValueChange={(value) => apply({ to: value ?? "" })}
          />
          <Input
            mono
            label={t("office.palletList.sscc")}
            hint={t("office.palletList.ssccHint")}
            value={ssccText}
            autoComplete="off"
            spellCheck={false}
            {...(ssccError ? { error: t("office.palletList.ssccInvalid") } : {})}
            onChange={(event) => {
              setSsccText(event.target.value);
              setSsccError(false);
            }}
          />
          <Button type="submit">{t("office.palletList.submit")}</Button>
          <Button type="button" variant="secondary" onClick={reset}>
            {t("office.palletList.reset")}
          </Button>
        </FilterBar>
      </form>
      {content()}
    </div>
  );
}
