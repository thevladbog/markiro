import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";

import {
  Button,
  Card,
  DatePicker,
  Drawer,
  EmptyState,
  FilterBar,
  Input,
  PageHeader,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { HostError } from "../../host/client.js";
import { CODE_MAX_PAGE, type OfficeCodeItem } from "../../host/code-search.js";
import { isCivilDate } from "../../lib/civil-date.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { OfficePager } from "../OfficePager.js";
import { LoadError, PageLoading } from "../page-state.js";
import { datePickerTexts } from "../shifts/shift-text.js";
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
import { classifySearchInput, searchQuery, type SearchInput } from "./code-query.js";

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
    page: Number.isInteger(page) && page > 1 && page <= CODE_MAX_PAGE ? page : 1,
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

function paramsOf(input: SearchInput, from: string, to: string, page: number): URLSearchParams {
  const params = new URLSearchParams();
  if (input.kind === "code") params.set("codeHash", input.codeHash);
  if (input.kind === "gtin") params.set("gtin", input.gtin14);
  if (input.kind === "sscc") params.set("sscc", input.sscc);
  if (input.kind === "shift") params.set("shift", input.number);
  if (from !== "") params.set("from", from);
  if (to !== "") params.set("to", to);
  if (page > 1) params.set("page", String(page));
  return params;
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
  const [from, setFrom] = useState(asked.from);
  const [to, setTo] = useState(asked.to);
  const [inputError, setInputError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  // The days of a period are the site's: the search waits for its zone.
  const zoneReady = !org.isPending;
  const zone = formTimeZone(org.data);
  const format = instantFormat(zone);
  const query = searchQuery(asked.input, asked.from, asked.to, zone, asked.page);
  const codeHash = asked.input.kind === "code" ? asked.input.codeHash : null;
  const card = useOfficeQuery(
    codeKeys.card(codeHash ?? ""),
    (api, token) => api.getCodeCard(token, codeHash ?? ""),
    { enabled: codeHash !== null },
  );
  const page = useOfficeQuery(
    codeKeys.page(query),
    (api, token) => {
      if (query === null) throw new Error("no search");
      return api.searchCodes(token, query);
    },
    { enabled: zoneReady && query !== null && codeHash === null },
  );
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
    setParams(paramsOf(input, from, to, 1));
  };
  const reset = () => {
    setText("");
    setFrom("");
    setTo("");
    setInputError(false);
    setParams(new URLSearchParams());
  };

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
  const results = () => {
    if (codeHash !== null) {
      if (card.isPending) return <PageLoading />;
      if (card.isError) {
        return isNotFound(card.error) ? (
          <EmptyState title={t("office.codeSearch.codeNotFound")} hint={notHere} />
        ) : (
          <LoadError error={card.error} onRetry={() => void card.refetch()} />
        );
      }
      return (
        <Card>
          <CodeCardView card={card.data} format={format} headingLevel="h2" />
        </Card>
      );
    }
    if (query === null) {
      return (
        <EmptyState
          title={t("office.codeSearch.prompt")}
          hint={t("office.codeSearch.promptHint")}
        />
      );
    }
    if (page.isPending) return <PageLoading />;
    if (page.isError) return <LoadError error={page.error} onRetry={() => void page.refetch()} />;
    if (page.data.total === 0) {
      return <EmptyState title={t("office.codeSearch.nothingFound")} hint={notHere} />;
    }
    return (
      <Card>
        <Table
          columns={columns}
          rows={page.data.items}
          getRowKey={(item) => item.scanId}
          onRowClick={(item) => setSelected(item.codeHash)}
          empty={t("office.codeSearch.pastLastPage")}
          scrollLabel={t("office.codeSearch.table.label")}
        />
        {page.data.pageCount > 1 && (
          <OfficePager
            label={t("office.codeSearch.pager")}
            page={page.data.page}
            pageCount={page.data.pageCount}
            onPage={(next) => setParams(paramsOf(asked.input, asked.from, asked.to, next))}
          />
        )}
      </Card>
    );
  };

  const total = page.isSuccess ? COUNT.format(page.data.total) : "";
  const summary =
    codeHash === null && page.isSuccess
      ? t(page.data.capped ? "office.codeSearch.capped" : "office.codeSearch.found", { total })
      : "";

  return (
    <div className="shift-card">
      <PageHeader title={t("office.codeSearch.title")} />
      <p className="office-note">{t("office.codeSearch.intro")}</p>
      <form role="search" aria-label={t("office.codeSearch.title")} onSubmit={submit} noValidate>
        <FilterBar
          label={t("office.codeSearch.filters")}
          resultSummary={summary}
          resetLabel={t("office.codeSearch.reset")}
          onReset={reset}
        >
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
          <DatePicker
            label={t("office.codeSearch.from")}
            {...datePickerTexts(t)}
            {...(from === "" ? {} : { value: from })}
            onValueChange={(value) => setFrom(value ?? "")}
          />
          <DatePicker
            label={t("office.codeSearch.to")}
            {...datePickerTexts(t)}
            {...(to === "" ? {} : { value: to })}
            {...(periodError ? { error: t("office.codeSearch.periodBackwards") } : {})}
            onValueChange={(value) => setTo(value ?? "")}
          />
          <Button type="submit">{t("office.codeSearch.submit")}</Button>
        </FilterBar>
      </form>
      {codeHash !== null && (asked.from !== "" || asked.to !== "") && (
        <p className="office-note">{t("office.codeSearch.periodIgnored")}</p>
      )}
      {results()}
      <Drawer
        open={selected !== null}
        title={t("office.codeSearch.card.title")}
        closeLabel={t("office.common.close")}
        onClose={() => setSelected(null)}
      >
        {selected !== null && <SelectedCard codeHash={selected} format={format} />}
      </Drawer>
    </div>
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
