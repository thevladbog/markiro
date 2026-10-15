import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Card,
  DatePicker,
  EmptyState,
  FilterBar,
  Input,
  Select,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import {
  SCAN_TAIL_PATTERN,
  SCAN_VERDICTS,
  type OfficeScanHistoryItem,
  type ScanHistoryQuery,
  type ScanVerdict,
} from "../../host/review.js";
import { isCivilDate } from "../../lib/civil-date.js";
import { BoxLink, PalletLink } from "../codes/PackLinks.js";
import { nextDay, zonedDayStartMs } from "../codes/code-query.js";
import { officeKeys, useOfficeInfiniteQuery, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { endsWithTail, ssccTail } from "./shift-card.js";
import { datePickerTexts } from "./shift-text.js";

/** A scan's result in its phase: the word carries the meaning, the tone only helps. */
const VERDICT_PHASE = {
  ok: "done",
  duplicate: "duplicate",
  wrong_gtin: "failed",
  invalid: "failed",
} as const satisfies Record<ScanVerdict, TagPhase>;

/** Counts with the thousands apart by a no-break space: «1 200». */
const COUNT = new Intl.NumberFormat("ru");

/** The filters as the person set them; an empty text is an unset filter. */
interface Filters {
  result: "" | ScanVerdict;
  device: string;
  /** The first day, `YYYY-MM-DD` (the organization's zone). */
  from: string;
  /** The last day, `YYYY-MM-DD`, included. */
  to: string;
  /** The serial's last characters, applied with «Показать». */
  tail: string;
  /** The box's SSCC last digits, applied with «Показать». */
  box: string;
}

const NO_FILTERS: Filters = { result: "", device: "", from: "", to: "", tail: "", box: "" };

/**
 * «Сканирования» of the shift's drawer (owner feedback after beta 3.2): the
 * history of the shift's scans, newest first, read a page at a time from the
 * host's journal. Each row says when, on which station, by which operator,
 * what came of it (accepted, duplicate, another product's code, not a code)
 * and where it went — the box and the pallet as links to their cards. The
 * code is shown masked: its GTIN and the last characters of the serial, never
 * the whole code, because the screen is shown over shoulders and in photos.
 *
 * Narrowed by the result, the station, a box (typed as the last digits of its
 * SSCC, and found among the shift's boxes), the days (in the organization's
 * zone) and the last characters of the serial. The same data is the station's
 * own «История сканирований» from its local copy.
 */
export function ShiftScans({
  shift,
  at,
  zone,
}: {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—». */
  at: (instant: string | null) => string;
  /** The organization's zone: it bounds the days of the period. */
  zone: string;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [tailText, setTailText] = useState("");
  const [boxText, setBoxText] = useState("");
  // The stations seen in any answer so far, by id: the select offers the shift's stations
  // (totals name their ids) by the names the journal gave.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const boxes = useOfficeQuery(
    officeKeys.shiftBoxes(shift.id),
    (api, token) => api.listShiftBoxes(token, shift.id),
    { enabled: filters.box !== "" },
  );

  const periodBackwards = filters.from !== "" && filters.to !== "" && filters.to < filters.from;
  const boxMatches =
    filters.box === "" || boxes.data === undefined
      ? []
      : boxes.data.filter((box) => endsWithTail(box.sscc, filters.box));
  // The box filter holds until the shift's boxes are read; then it names one box, or none/many.
  const boxPending = filters.box !== "" && boxes.isPending;
  const boxError =
    filters.box === "" || boxes.data === undefined
      ? null
      : boxMatches.length === 0
        ? "none"
        : boxMatches.length > 1
          ? "many"
          : null;
  const query = useMemo((): ScanHistoryQuery | null => {
    if (periodBackwards || boxPending || boxError !== null) return null;
    const next: ScanHistoryQuery = {};
    if (filters.result !== "") next.result = filters.result;
    if (filters.device !== "") next.device = filters.device;
    const only = boxMatches.length === 1 ? boxMatches[0] : undefined;
    if (only !== undefined) next.box = only.id;
    if (isCivilDate(filters.from)) next.fromMs = zonedDayStartMs(filters.from, zone);
    if (isCivilDate(filters.to)) next.toMs = zonedDayStartMs(nextDay(filters.to), zone);
    if (filters.tail !== "") next.q = filters.tail;
    return next;
    // `boxMatches` is derived from the two values named here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, zone, periodBackwards, boxPending, boxError, boxes.data]);

  const pages = useOfficeInfiniteQuery(
    officeKeys.shiftScans(shift.id, query ?? {}),
    (api, token, cursor) => api.listShiftScans(token, shift.id, query ?? {}, cursor),
    (page) => page.nextCursor,
    { enabled: query !== null },
  );
  const listed = query !== null && pages.data !== undefined;
  const rows = useMemo(
    () => (listed ? (pages.data?.pages.flatMap((page) => page.items) ?? []) : []),
    [listed, pages.data],
  );

  useEffect(() => {
    if (rows.length === 0) return;
    setNames((previous) => {
      const next = new Map(previous);
      for (const item of rows) next.set(item.deviceId, item.deviceName);
      return next.size === previous.size ? previous : next;
    });
  }, [rows]);

  const time = (instant: string) => at(instant);
  const apply = (change: Partial<Filters>) =>
    setFilters((previous) => ({ ...previous, ...change }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply({ tail: tailText.trim(), box: boxText });
  };
  const reset = () => {
    setFilters(NO_FILTERS);
    setTailText("");
    setBoxText("");
  };
  const filtersOn =
    JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) || tailText !== "" || boxText !== "";
  const tailInvalid = tailText.trim() !== "" && !SCAN_TAIL_PATTERN.test(tailText.trim());

  const deviceOptions = [
    { value: "", label: t("office.shiftCard.scans.allStations") },
    ...[...new Set([...shift.totals.deviceIds, ...names.keys()])].map((id) => ({
      value: id,
      label: names.get(id) ?? t("office.shiftCard.scans.stationId", { id: id.slice(0, 8) }),
    })),
  ];

  const columns: TableColumn<OfficeScanHistoryItem>[] = [
    {
      key: "scannedAt",
      title: t("office.shiftCard.scans.when"),
      mono: true,
      render: (scan) => time(scan.scannedAt),
    },
    {
      key: "deviceName",
      title: t("office.shiftCard.scans.station"),
      wrap: true,
      minWidth: 110,
    },
    {
      key: "operatorName",
      title: t("office.shiftCard.scans.operator"),
      wrap: true,
      minWidth: 110,
      render: (scan) => scan.operatorName ?? t("office.common.none"),
    },
    {
      key: "verdict",
      title: t("office.shiftCard.scans.result"),
      wrap: true,
      minWidth: 220,
      render: (scan) => (
        <span className="shift-cell">
          <StatusChip
            phase={VERDICT_PHASE[scan.verdict]}
            label={t(`office.shiftCard.scans.verdicts.${scan.verdict}`)}
          />
          <span className="shift-cell__quiet">
            {t(
              scan.verdict === "duplicate"
                ? `office.shiftCard.scans.reasons.duplicate_${scan.duplicateSource === "host" ? "host" : "local"}`
                : `office.shiftCard.scans.reasons.${scan.verdict}`,
            )}
          </span>
        </span>
      ),
    },
    {
      key: "code",
      title: t("office.shiftCard.scans.code"),
      mono: true,
      render: (scan) =>
        scan.gtin14 === null
          ? t("office.common.none")
          : t("office.shiftCard.scans.maskedCode", {
              gtin: scan.gtin14,
              tail: scan.serialTail ?? "",
            }),
    },
    {
      key: "box",
      title: t("office.shiftCard.scans.box"),
      mono: true,
      render: (scan) =>
        scan.boxId === null ? (
          t("office.common.none")
        ) : (
          <BoxLink id={scan.boxId} sscc={scan.boxSscc} />
        ),
    },
    {
      key: "pallet",
      title: t("office.shiftCard.scans.pallet"),
      mono: true,
      render: (scan) =>
        scan.palletId === null ? (
          t("office.common.none")
        ) : (
          <PalletLink id={scan.palletId} sscc={scan.palletSscc} />
        ),
    },
  ];

  const content = () => {
    if (periodBackwards || boxError !== null) return null;
    if (query === null || pages.isPending || pages.isPlaceholderData) return <PageLoading />;
    if (pages.isError && pages.data === undefined) {
      return <LoadError error={pages.error} onRetry={() => void pages.refetch()} />;
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          title={t(
            filtersOn ? "office.shiftCard.scans.nothingFound" : "office.shiftCard.scans.empty",
          )}
        />
      );
    }
    return (
      <>
        <Table
          columns={columns}
          rows={rows}
          getRowKey={(scan) => scan.id}
          scrollLabel={t("office.shiftCard.scans.table")}
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
            {t("office.shiftCard.scans.loadMore")}
          </Button>
        )}
      </>
    );
  };

  return (
    <section className="shift-card__section" aria-label={t("office.shiftCard.scans.title")}>
      <h2>{t("office.shiftCard.scans.title")}</h2>
      <p className="office-note">{t("office.shiftCard.scans.hint")}</p>
      <form
        role="search"
        aria-label={t("office.shiftCard.scans.filters")}
        onSubmit={submit}
        noValidate
      >
        <FilterBar
          label={t("office.shiftCard.scans.filters")}
          resultSummary={
            pages.isSuccess && listed
              ? t("office.shiftCard.scans.shown", { shown: COUNT.format(rows.length) })
              : ""
          }
        >
          <Select
            label={t("office.shiftCard.scans.resultFilter")}
            options={[
              { value: "", label: t("office.shiftCard.scans.allResults") },
              ...SCAN_VERDICTS.map((value) => ({
                value,
                label: t(`office.shiftCard.scans.verdicts.${value}`),
              })),
            ]}
            value={filters.result}
            onValueChange={(value) => apply({ result: value })}
          />
          <Select
            label={t("office.shiftCard.scans.station")}
            options={deviceOptions}
            value={filters.device}
            onValueChange={(device) => apply({ device })}
          />
          <DatePicker
            label={t("office.shiftCard.scans.from")}
            {...datePickerTexts(t)}
            {...(filters.from === "" ? {} : { value: filters.from })}
            onValueChange={(value) => apply({ from: value ?? "" })}
          />
          <DatePicker
            label={t("office.shiftCard.scans.to")}
            {...datePickerTexts(t)}
            {...(filters.to === "" ? {} : { value: filters.to })}
            {...(periodBackwards ? { error: t("office.shiftCard.scans.periodBackwards") } : {})}
            onValueChange={(value) => apply({ to: value ?? "" })}
          />
          <Input
            mono
            label={t("office.shiftCard.scans.boxFilter")}
            hint={t("office.shiftCard.scans.boxFilterHint")}
            inputMode="numeric"
            autoComplete="off"
            value={boxText}
            {...(boxError === null
              ? {}
              : { error: t(`office.shiftCard.scans.boxErrors.${boxError}`) })}
            onChange={(event) => setBoxText(ssccTail(event.target.value))}
          />
          <Input
            mono
            label={t("office.shiftCard.scans.tailFilter")}
            hint={t("office.shiftCard.scans.tailFilterHint")}
            autoComplete="off"
            spellCheck={false}
            value={tailText}
            {...(tailInvalid ? { error: t("office.shiftCard.scans.tailInvalid") } : {})}
            onChange={(event) => setTailText(event.target.value)}
          />
          <Button type="submit" disabled={tailInvalid}>
            {t("office.shiftCard.scans.submit")}
          </Button>
          {filtersOn && (
            <Button type="button" variant="secondary" onClick={reset}>
              {t("office.shiftCard.scans.reset")}
            </Button>
          )}
        </FilterBar>
      </form>
      <Card>{content()}</Card>
    </section>
  );
}
