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
import {
  CODE_PAGE_SIZE,
  CODE_SEARCH_CAP,
  type OfficeCodeItem,
  type OfficeCodePage,
} from "../../host/code-search.js";
import { civilToday, isCivilDate } from "../../lib/civil-date.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { DateRange, FilterGroup, FilterPanel, FilterRow, ListCard } from "../list/ListCard.js";
import { Segmented } from "../list/Segmented.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { PaginationBar } from "../paging/PaginationBar.js";
import { usePageSize } from "../paging/page-size.js";
import { useHostWindowRows } from "../paging/use-host-window.js";
import { LoadError, PageLoading } from "../page-state.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import {
  boxLabel,
  CodeCardView,
  codeText,
  instantFormat,
  palletLabel,
  PlacementChip,
  ShiftLink,
  type FormatInstant,
} from "./CodeCard.js";
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
  page: (query: unknown) => ["office", "codes", "page", query],
  card: (codeHash: string) => ["office", "codes", "card", codeHash],
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
): URLSearchParams {
  const params = new URLSearchParams();
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

/**
 * «Поиск кодов» (the owner's beta feedback; the cloud admin's code search
 * for one site): a code of marking, a GTIN, a box's or a pallet's SSCC or a
 * shift's number, and a period of scan days, find where codes were put. A
 * code opens its card at once; any other search lists the placements and a
 * row opens its code's card. Only what the stations of this site sent is
 * here: the cloud's history does not move with the transfer. Every role
 * reads it; times are in the organization's zone, as on a shift's card.
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
  const hostQuery = (hostPage: number) =>
    searchQuery(asked.input, applied.from, applied.to, zone, hostPage, asked.all);
  const query = hostQuery(1);
  const activeShifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) =>
    api.listShifts(token),
  );
  const activeShift = activeShifts.data?.find((shift) => shift.status === "active") ?? null;
  const codeHash = asked.input.kind === "code" ? asked.input.codeHash : null;
  const card = useOfficeQuery(
    codeKeys.card(codeHash ?? ""),
    (api, token) => api.getCodeCard(token, codeHash ?? ""),
    { enabled: codeHash !== null },
  );
  const window = useHostWindowRows<OfficeCodeItem, OfficeCodePage>({
    page: askedPage,
    pageSize,
    hostSize: CODE_PAGE_SIZE,
    keyOf: (hostPage) => codeKeys.page(hostQuery(hostPage)),
    read: (api, token, hostPage) => {
      const next = hostQuery(hostPage);
      if (next === null) throw new Error("no search");
      return api.searchCodes(token, next);
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
    setParams(paramsOf(input, from, to, 1, everything));
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
    setParams(paramsOf(input, period.from, period.to, 1, preset === "all"));
  };
  const reset = () => {
    setText("");
    setEdit(null);
    setInputError(false);
    setParams(new URLSearchParams());
  };
  const activePreset = presetOf(shown, today);

  const columns: TableColumn<OfficeCodeItem>[] = [
    {
      key: "code",
      title: t("office.codeSearch.table.code"),
      mono: true,
      render: (item) => codeText(item),
    },
    { key: "productName", title: t("office.codeSearch.table.product") },
    {
      key: "state",
      title: t("office.codeSearch.table.state"),
      render: (item) => <PlacementChip state={item.state} />,
    },
    {
      key: "box",
      title: t("office.codeSearch.table.box"),
      mono: true,
      render: (item) => boxLabel(item, t),
    },
    {
      key: "pallet",
      title: t("office.codeSearch.table.pallet"),
      mono: true,
      render: (item) => palletLabel(item, t),
    },
    {
      key: "shift",
      title: t("office.codeSearch.table.shift"),
      render: (item) => <ShiftLink item={item} />,
    },
    { key: "lineName", title: t("office.codeSearch.table.line") },
    {
      key: "scannedAt",
      title: t("office.codeSearch.table.scannedAt"),
      mono: true,
      render: (item) => format(item.scannedAt),
    },
    {
      key: "operatorName",
      title: t("office.codeSearch.table.operator"),
      render: (item) => item.operatorName ?? t("office.common.none"),
    },
  ];

  const notHere = t("office.codeSearch.notHere");
  /** What stands in the card in the place of the table: a prompt, a state, one code's card. */
  const body = (node: ReactNode) => <div className="office-list-body">{node}</div>;
  const results = () => {
    if (codeHash !== null) {
      if (card.isPending) return body(<PageLoading />);
      if (card.isError) {
        return body(
          isNotFound(card.error) ? (
            <EmptyState title={t("office.codeSearch.codeNotFound")} hint={notHere} />
          ) : (
            <LoadError error={card.error} onRetry={() => void card.refetch()} />
          ),
        );
      }
      return body(<CodeCardView card={card.data} format={format} headingLevel="h2" />);
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
          columns={columns}
          rows={rows}
          getRowKey={(item) => item.scanId}
          onRowClick={(item) => setSelected(item.codeHash)}
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
          onPage={(next) => setParams(paramsOf(asked.input, asked.from, asked.to, next, asked.all))}
          onPageSize={(size) => {
            setPageSize(size);
            setParams(paramsOf(asked.input, asked.from, asked.to, 1, asked.all));
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
        {selected !== null && <SelectedCard codeHash={selected} format={format} />}
      </Drawer>
    </>
  );
}

function SelectedCard({ codeHash, format }: { codeHash: string; format: FormatInstant }) {
  const { t } = useTranslation();
  const card = useOfficeQuery(codeKeys.card(codeHash), (api, token) =>
    api.getCodeCard(token, codeHash),
  );
  if (card.isPending) return <PageLoading />;
  if (card.isError) {
    return isNotFound(card.error) ? (
      <EmptyState title={t("office.codeSearch.codeNotFound")} />
    ) : (
      <LoadError error={card.error} onRetry={() => void card.refetch()} />
    );
  }
  return <CodeCardView card={card.data} format={format} headingLevel="h3" />;
}
