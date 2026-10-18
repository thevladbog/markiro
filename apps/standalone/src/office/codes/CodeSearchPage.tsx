import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useSearchParams } from "react-router";

import {
  Button,
  Drawer,
  EmptyState,
  Input,
  PageHeader,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { HostApi } from "../../host/api.js";
import { CODE_PAGE_SIZE, CODE_SEARCH_CAP } from "../../host/code-search.js";
import type {
  CodeRegistryItem,
  CodeRegistryPage,
  CodeRegistrySource,
} from "../../host/code-registry.js";
import {
  CodeRegistryCardView,
  SourceChip,
  RegistryState,
  RegistryShift,
  CloudPack,
  cloudInstant,
  registryCodeText,
  registryKey,
} from "./CodeRegistryCard.js";
import { civilToday, isCivilDate } from "../../lib/civil-date.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { DateRange, FilterGroup, FilterPanel, FilterRow, ListCard } from "../list/ListCard.js";
import { Segmented } from "../list/Segmented.js";
import { tableFloorStyle } from "../list/fill-model.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { PaginationBar } from "../paging/PaginationBar.js";
import { usePageSize } from "../paging/page-size.js";
import { useHostWindowRows } from "../paging/use-host-window.js";
import { LoadError, PageLoading } from "../page-state.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import { boxLabel, instantFormat, palletLabel, type FormatInstant } from "./CodeCard.js";
import {
  classifySearchInput,
  DEFAULT_PRESET,
  PERIOD_PRESETS,
  presetOf,
  presetPeriod,
  searchQuery,
  type CivilPeriod,
  type PeriodPreset,
  type SearchInput,
} from "./code-query.js";
import { RegistryTabs } from "./RegistryTabs.js";

/** Counts with the thousands apart by a no-break space: «10 000». */
const COUNT = new Intl.NumberFormat("ru");

/** The query keys of the search: a page of one query, one code's card. */
const codeKeys = {
  page: (query: unknown) => ["office", "code-registry", "page", query],
  card: (codeHash: string, source: CodeRegistrySource) => [
    "office",
    "code-registry",
    "card",
    codeHash,
    source,
  ],
} as const;

/**
 * The search lives in the address (`?gtin=…&from=…&page=…`), so «Назад»
 * from a shift's card finds it again. A code is kept there as its hash,
 * never as its text.
 */
function askedOf(params: URLSearchParams): {
  input: SearchInput;
  from: string;
  to: string;
  /** `?period=all`: every scan day, asked for on purpose. */
  all: boolean;
  page: number;
  source: CodeRegistrySource;
} {
  const codeHash = params.get("codeHash");
  const gtin = params.get("gtin");
  const sscc = params.get("sscc");
  const shift = params.get("shift");
  let input: SearchInput = { kind: "empty" };
  if (codeHash !== null && /^[0-9a-f]{64}$/.test(codeHash)) input = { kind: "code", codeHash };
  else if (gtin !== null && /^[0-9]{14}$/.test(gtin)) input = { kind: "gtin", gtin14: gtin };
  else if (sscc !== null && /^[0-9]{18}$/.test(sscc)) input = { kind: "sscc", sscc };
  else if (shift !== null) {
    const read = classifySearchInput(shift);
    if (read.kind === "shift") input = read;
  }
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const page = Number(params.get("page"));
  return {
    input,
    source:
      params.get("source") === "cloud"
        ? "cloud"
        : params.get("source") === "local"
          ? "local"
          : "all",
    from: isCivilDate(from) ? from : "",
    to: isCivilDate(to) ? to : "",
    all: params.get("period") === "all",
    page: Number.isInteger(page) && page > 1 && page <= CODE_SEARCH_CAP ? page : 1,
  };
}

/** The text the search box shows for a criterion read from the address. */
function inputText(input: SearchInput): string {
  switch (input.kind) {
    case "gtin":
      return input.gtin14;
    case "sscc":
      return input.sscc;
    case "shift":
      return input.number;
    default:
      return "";
  }
}

function paramsOf(
  input: SearchInput,
  from: string,
  to: string,
  page: number,
  all = false,
  source: CodeRegistrySource = "all",
): URLSearchParams {
  const params = new URLSearchParams();
  if (source !== "all") params.set("source", source);
  if (input.kind === "code") params.set("codeHash", input.codeHash);
  if (input.kind === "gtin") params.set("gtin", input.gtin14);
  if (input.kind === "sscc") params.set("sscc", input.sscc);
  if (input.kind === "shift") params.set("shift", input.number);
  if (from !== "") params.set("from", from);
  if (to !== "") params.set("to", to);
  if (all) params.set("period", "all");
  if (page > 1) params.set("page", String(page));
  return params;
}

/** «Период: 03.10.2026 — 09.10.2026», or «всё время» without days. */
function periodSentence(t: TFunction, period: CivilPeriod): string {
  if (period.from === "" && period.to === "") return t("office.codeSearch.period.everything");
  if (period.from !== "" && period.to !== "") {
    return t("office.codeSearch.period.range", {
      from: civilDateLabel(period.from),
      to: civilDateLabel(period.to),
    });
  }
  return period.from !== ""
    ? t("office.codeSearch.period.since", { from: civilDateLabel(period.from) })
    : t("office.codeSearch.period.until", { to: civilDateLabel(period.to) });
}

function isNotFound(error: unknown): boolean {
  return error instanceof HostError && error.code === "not_found";
}

class RegistryUnavailable extends Error {}

/** A legacy host and a missing code both answer 404; the collection distinguishes them. */
async function readRegistryCard(
  api: HostApi,
  token: string,
  hash: string,
  source: CodeRegistrySource,
) {
  try {
    return await api.getCodeRegistryCard(token, hash, source);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      await api.searchCodeRegistry(token, { codeHash: hash, source });
    } catch (probeError) {
      if (isNotFound(probeError)) throw new RegistryUnavailable();
      throw probeError;
    }
    throw error;
  }
}

/**
 * «Поиск кодов» (the owner's beta feedback; the cloud admin's code search
 * for one site): a code of marking, a GTIN, a box's or a pallet's SSCC or a
 * shift's number, and a period of scan days, find where codes were put. A
 * code opens its card at once; any other search lists the placements and a
 * row opens its code's card. Local journals and accepted imported snapshots
 * share the search, with explicit provenance and original source timezones.
 */
export function CodeSearchPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const asked = askedOf(params);
  const [text, setText] = useState(() => inputText(asked.input));
  // The days the user typed into the pickers; `null` follows the address.
  const [edit, setEdit] = useState<CivilPeriod | null>(null);
  const [inputError, setInputError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  // The days of a period are the site's: the search waits for its zone.
  const zoneReady = !org.isPending;
  const zone = formTimeZone(org.data);
  const format = instantFormat(zone);
  const today = civilToday(zone);
  // «Поиск кодов» opens on the last seven days: with no criterion and no period
  // in the address the default period applies. An explicit search is unchanged.
  const defaulted =
    asked.input.kind === "empty" && asked.from === "" && asked.to === "" && !asked.all;
  const applied: CivilPeriod = defaulted
    ? presetPeriod(DEFAULT_PRESET, today)
    : { from: asked.from, to: asked.to };
  const typing = classifySearchInput(text).kind !== "empty";
  // A criterion typed over the default period is searched over all the time.
  const shown: CivilPeriod = edit ?? (typing && defaulted ? { from: "", to: "" } : applied);
  const from = shown.from;
  const to = shown.to;
  // The host pages a search by number, 50 rows a page; the office shows pages of its own size, and
  // `?page=` is the office's page.
  const [pageSize, setPageSize] = usePageSize("code-search");
  const askedPage = Math.min(asked.page, Math.ceil(CODE_SEARCH_CAP / pageSize));
  const hostQuery = (hostPage: number) => {
    const query = searchQuery(asked.input, applied.from, applied.to, zone, hostPage, asked.all);
    return query === null ? null : { ...query, source: asked.source };
  };
  const query = hostQuery(1);
  const activeShifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) =>
    api.listShifts(token),
  );
  const activeShift = activeShifts.data?.find((shift) => shift.status === "active") ?? null;
  const codeHash = asked.input.kind === "code" ? asked.input.codeHash : null;
  const card = useOfficeQuery(
    codeKeys.card(codeHash ?? "", asked.source),
    (api, token) => readRegistryCard(api, token, codeHash ?? "", asked.source),
    { enabled: codeHash !== null },
  );
  const window = useHostWindowRows<CodeRegistryItem, CodeRegistryPage>({
    page: askedPage,
    pageSize,
    hostSize: CODE_PAGE_SIZE,
    keyOf: (hostPage) => codeKeys.page(hostQuery(hostPage)),
    read: (api, token, hostPage) => {
      const next = hostQuery(hostPage);
      if (next === null) throw new Error("no search");
      return api.searchCodeRegistry(token, next);
    },
    enabled: zoneReady && query !== null && codeHash === null,
  });
  const page = window.first;
  const periodError = from !== "" && to !== "" && to < from;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = classifySearchInput(text);
    if (input.kind === "unknown") {
      setInputError(true);
      return;
    }
    setInputError(false);
    if (periodError) return;
    // No criterion and no days: every day, on purpose (the host wants one of them).
    const everything = input.kind === "empty" && from === "" && to === "";
    setEdit(null);
    setParams(paramsOf(input, from, to, 1, everything, asked.source));
  };
  const choosePreset = (preset: PeriodPreset) => {
    const input = classifySearchInput(text);
    if (input.kind === "unknown") {
      setInputError(true);
      return;
    }
    setInputError(false);
    const period = presetPeriod(preset, today);
    setEdit(null);
    setParams(paramsOf(input, period.from, period.to, 1, preset === "all", asked.source));
  };
  const reset = () => {
    setText("");
    setEdit(null);
    setInputError(false);
    setParams(new URLSearchParams());
  };
  const activePreset = presetOf(shown, today);

  const columns: TableColumn<CodeRegistryItem>[] = [
    { key: "code", title: t("office.codeSearch.table.code"), mono: true, render: registryCodeText },
    {
      key: "source",
      title: t("office.codeSearch.sources.label"),
      render: (row) => <SourceChip source={row.source} />,
    },
    {
      key: "productName",
      title: t("office.codeSearch.table.product"),
      render: (row) => row.item.productName ?? t("office.common.none"),
    },
    {
      key: "state",
      title: t("office.codeSearch.table.state"),
      render: (row) => <RegistryState row={row} />,
    },
    {
      key: "box",
      title: t("office.codeSearch.table.box"),
      mono: true,
      render: (row) =>
        row.source === "local" ? boxLabel(row.item, t) : <CloudPack item={row.item} kind="box" />,
    },
    {
      key: "pallet",
      title: t("office.codeSearch.table.pallet"),
      mono: true,
      render: (row) =>
        row.source === "local" ? (
          palletLabel(row.item, t)
        ) : (
          <CloudPack item={row.item} kind="pallet" />
        ),
    },
    {
      key: "shift",
      title: t("office.codeSearch.table.shift"),
      render: (row) => <RegistryShift row={row} />,
    },
    {
      key: "lineName",
      title: t("office.codeSearch.table.line"),
      render: (row) => row.item.lineName ?? t("office.common.none"),
    },
    {
      key: "scannedAt",
      title: t("office.codeSearch.table.scannedAt"),
      mono: true,
      render: (row) =>
        row.source === "local" ? format(row.item.scannedAt) : cloudInstant(row.item),
    },
    {
      key: "operatorName",
      title: t("office.codeSearch.table.operator"),
      render: (row) =>
        row.source === "local"
          ? (row.item.operatorName ?? t("office.common.none"))
          : t("office.common.none"),
    },
  ];

  const notHere = t("office.codeSearch.notHere");
  /** What stands in the card in the place of the table: a prompt, a state, one code's card. */
  const body = (node: ReactNode) => <div className="office-list-body">{node}</div>;
  const results = () => {
    if (codeHash !== null) {
      if (card.isPending) return body(<PageLoading />);
      if (card.isError) {
        if (card.error instanceof RegistryUnavailable)
          return body(<EmptyState title={t("office.codeSearch.hostUpdateRequired")} />);
        return body(
          isNotFound(card.error) ? (
            <EmptyState title={t("office.codeSearch.codeNotFound")} hint={notHere} />
          ) : (
            <LoadError error={card.error} onRetry={() => void card.refetch()} />
          ),
        );
      }
      return body(<CodeRegistryCardView card={card.data} format={format} headingLevel="h2" />);
    }
    if (query === null) {
      return body(
        <EmptyState
          icon={<OfficeIcon name="search" size={32} />}
          title={t("office.codeSearch.prompt")}
          hint={t("office.codeSearch.promptHint")}
        />,
      );
    }
    const periodNote = applied.from === "" && applied.to === "" ? null : periodSentence(t, applied);
    if (page.isPending) return body(<PageLoading />);
    if (page.isError) {
      if (isNotFound(page.error))
        return body(<EmptyState title={t("office.codeSearch.hostUpdateRequired")} />);
      return body(<LoadError error={page.error} onRetry={() => void page.refetch()} />);
    }
    if (page.data.total === 0) {
      return body(
        <EmptyState
          icon={<OfficeIcon name="search" size={32} />}
          title={t("office.codeSearch.nothingFound")}
          hint={
            periodNote === null
              ? notHere
              : `${t("office.codeSearch.nothingInPeriod", { period: periodNote })} ${notHere}`
          }
        />,
      );
    }
    const rows = window.rows;
    if (rows === undefined) {
      return body(
        window.second.isError ? (
          <LoadError error={window.second.error} onRetry={() => void window.second.refetch()} />
        ) : (
          <PageLoading />
        ),
      );
    }
    const shown = Math.min(askedPage, window.pageCount);
    return (
      <div className="office-paged">
        <Table
          fill
          style={tableFloorStyle(rows.length)}
          columns={columns}
          rows={rows}
          getRowKey={registryKey}
          onRowClick={(item) => setSelected(item.item.codeHash)}
          empty={t("office.codeSearch.pastLastPage")}
          scrollLabel={t("office.codeSearch.table.label")}
        />
        <PaginationBar
          label={t("office.codeSearch.pager")}
          name={t("office.codeSearch.table.label")}
          page={shown}
          pageSize={pageSize}
          shownRows={rows.length}
          total={window.reachable}
          pageCount={window.pageCount}
          hasNext={shown < window.pageCount}
          onPage={(next) =>
            setParams(paramsOf(asked.input, asked.from, asked.to, next, asked.all, asked.source))
          }
          onPageSize={(size) => {
            setPageSize(size);
            setParams(paramsOf(asked.input, asked.from, asked.to, 1, asked.all, asked.source));
          }}
        />
      </div>
    );
  };

  const total = page.isSuccess ? COUNT.format(page.data.total) : "";
  const summary =
    codeHash === null && page.isSuccess
      ? t(page.data.capped ? "office.codeSearch.capped" : "office.codeSearch.found", { total })
      : "";

  return (
    <>
      <PageHeader
        title={t("office.codeSearch.title")}
        description={t("office.codeSearch.subtitle")}
      />
      <RegistryTabs active="codes" />
      <p className="office-note">{t("office.codeSearch.intro")}</p>
      <ListCard>
        <form
          role="search"
          aria-label={t("office.codeSearch.title")}
          className="office-list-form"
          onSubmit={submit}
          noValidate
        >
          <FilterPanel label={t("office.codeSearch.filters")}>
            <FilterRow>
              <FilterGroup label={t("office.codeSearch.sources.label")}>
                <Segmented
                  label={t("office.codeSearch.sources.label")}
                  value={asked.source}
                  options={(["all", "local", "cloud"] as const).map((id) => ({
                    id,
                    label: t(`office.codeSearch.sources.${id}`),
                  }))}
                  onChange={(source) => {
                    setSelected(null);
                    setParams(paramsOf(asked.input, asked.from, asked.to, 1, asked.all, source));
                  }}
                />
              </FilterGroup>
            </FilterRow>
            <FilterRow>
              <Input
                mono
                label={t("office.codeSearch.input")}
                hint={t("office.codeSearch.inputHint")}
                value={text}
                autoComplete="off"
                spellCheck={false}
                {...(inputError ? { error: t("office.codeSearch.inputUnknown") } : {})}
                onChange={(event) => {
                  setText(event.target.value);
                  setInputError(false);
                }}
              />
              <div className="office-filter-row__end office-filter-row__end--top">
                <Button type="submit" icon={<OfficeIcon name="search" size={20} />}>
                  {t("office.codeSearch.submit")}
                </Button>
                <Button
                  variant="secondary"
                  icon={<OfficeIcon name="reset" size={20} />}
                  onClick={reset}
                >
                  {t("office.codeSearch.reset")}
                </Button>
              </div>
            </FilterRow>
            <FilterRow>
              <FilterGroup label={t("office.codeSearch.period.label")}>
                <Segmented
                  label={t("office.codeSearch.period.label")}
                  value={activePreset}
                  options={PERIOD_PRESETS.map((preset) => ({
                    id: preset,
                    label: t(`office.codeSearch.period.${preset}`),
                  }))}
                  onChange={choosePreset}
                />
              </FilterGroup>
              <DateRange
                label={t("office.codeSearch.scanned")}
                fromLabel={t("office.codeSearch.from")}
                toLabel={t("office.codeSearch.to")}
                from={from}
                to={to}
                onFrom={(value) => setEdit({ from: value, to })}
                onTo={(value) => setEdit({ from, to: value })}
                error={periodError ? t("office.codeSearch.periodBackwards") : undefined}
              />
              <p className="office-list-filters__found office-filter-row__end" aria-live="polite">
                {summary}
              </p>
            </FilterRow>
          </FilterPanel>
        </form>
        {((codeHash === null && query !== null) ||
          (codeHash !== null && (asked.from !== "" || asked.to !== ""))) && (
          <div className="office-list-notes">
            {codeHash === null && query !== null && (
              <p className="office-list-note" data-testid="code-period-note">
                {[
                  t("office.codeSearch.period.applied", { period: periodSentence(t, applied) }),
                  defaulted ? t("office.codeSearch.period.default") : null,
                  t("office.codeSearch.period.todayIs", { date: civilDateLabel(today) }),
                  activeShift === null
                    ? null
                    : t("office.codeSearch.period.activeShift", { number: activeShift.number }),
                ]
                  .filter((part) => part !== null)
                  .join(". ")}
              </p>
            )}
            {codeHash !== null && (asked.from !== "" || asked.to !== "") && (
              <p className="office-list-note">{t("office.codeSearch.periodIgnored")}</p>
            )}
          </div>
        )}
        {results()}
      </ListCard>
      <Drawer
        open={selected !== null}
        title={t("office.codeSearch.card.title")}
        closeLabel={t("office.common.close")}
        onClose={() => setSelected(null)}
      >
        {selected !== null && (
          <SelectedCard codeHash={selected} format={format} source={asked.source} />
        )}
      </Drawer>
    </>
  );
}

function SelectedCard({
  codeHash,
  format,
  source,
}: {
  codeHash: string;
  format: FormatInstant;
  source: CodeRegistrySource;
}) {
  const { t } = useTranslation();
  const card = useOfficeQuery(codeKeys.card(codeHash, source), (api, token) =>
    readRegistryCard(api, token, codeHash, source),
  );
  if (card.isPending) return <PageLoading />;
  if (card.isError) {
    if (card.error instanceof RegistryUnavailable)
      return <EmptyState title={t("office.codeSearch.hostUpdateRequired")} />;
    return isNotFound(card.error) ? (
      <EmptyState title={t("office.codeSearch.codeNotFound")} />
    ) : (
      <LoadError error={card.error} onRetry={() => void card.refetch()} />
    );
  }
  return <CodeRegistryCardView card={card.data} format={format} headingLevel="h3" />;
}
