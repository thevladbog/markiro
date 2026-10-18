import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, StatusChip, type TagPhase } from "@markiro/ui";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { ScanCode } from "./ScanCode.js";
import { codeDisplay, readScanHistory, SERIAL_FULL, type ScanHistoryRow } from "./scan-history.js";
import "./scan-history.css";

/** Rows in the work screen's own list: the last scans, with «Вся история» for the rest. */
export const COMPACT_ROWS = 8;
/** Rows on a page of the full history: 64 px rows that fit the touch panel. */
export const PAGE_ROWS = 7;

const TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const PHASE: Record<ScanHistoryRow["verdict"], TagPhase> = {
  ok: "done",
  duplicate: "duplicate",
  wrong_gtin: "failed",
  invalid: "failed",
};

/** The time of a scan on this PC's clock, `HH:MM:SS`; the text itself when it is no instant. */
function timeOf(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : TIME.format(date);
}

/** The scan's result as a chip: accepted, duplicate (with its source), or rejected with a reason. */
function useResult() {
  const { t } = useTranslation();
  return (row: ScanHistoryRow) => ({
    label: t(`floor.scanHistory.verdict.${row.verdict}`),
    reason:
      row.verdict === "ok"
        ? null
        : row.verdict === "duplicate"
          ? t(`floor.scanHistory.reason.duplicate_${row.duplicateSource ?? "local"}`)
          : t(`floor.scanHistory.reason.${row.verdict}`),
  });
}

/** The code as a screen reader hears it: the whole GTIN and serial, else the masked line. */
function spokenCode(row: ScanHistoryRow, noCode: string): string {
  return codeDisplay(row.gtin14, row.serial, SERIAL_FULL)?.full ?? row.maskedCode ?? noCode;
}

/** How many whole rows a list of `available` px holds: rows of `row` px with `gap` between them. */
export function wholeRowsThatFit(available: number, row: number, gap: number): number {
  if (!(row > 0) || !(available > 0)) return 0;
  return Math.max(0, Math.floor((available + gap) / (row + gap)));
}

/**
 * The number of the list's rows that fit WHOLE in its box, or `null` while that is unknown (no
 * layout yet, as in a test's DOM): the list shows that many rows, never a cut one. Measured from
 * the list's own height (a flexible grid row) and its first row's height, again on every resize.
 */
export function useWholeRows(listRef: RefObject<HTMLUListElement | null>, rowCount: number) {
  const [fit, setFit] = useState<number | null>(null);
  // The row's height is read while a row stands; when none fits (fit 0) the last reading holds.
  const rowHeight = useRef(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || rowCount === 0) return undefined;
    const measure = () => {
      const first = list.querySelector<HTMLElement>(".scan-history__row");
      if (first !== null && first.offsetHeight > 0) rowHeight.current = first.offsetHeight;
      const height = list.clientHeight;
      if (!(rowHeight.current > 0)) {
        setFit(null);
        return;
      }
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      setFit(wholeRowsThatFit(height, rowHeight.current, gap));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, rowCount]);
  return fit;
}

function HistoryRow({ row }: { row: ScanHistoryRow }) {
  const { t } = useTranslation();
  const result = useResult()(row);
  const operator = row.operatorName ?? t("floor.scanHistory.noOperator");
  const position =
    row.boxPosition === null
      ? t("floor.scanHistory.noBox")
      : t("floor.scanHistory.position_n", { n: row.boxPosition });
  const code = row.maskedCode ?? t("floor.scanHistory.noCode");
  return (
    <li
      className="scan-history__row"
      data-verdict={row.verdict}
      aria-label={t("floor.scanHistory.row", {
        time: timeOf(row.scannedAt),
        operator,
        position,
        result: result.reason === null ? result.label : `${result.label}: ${result.reason}`,
        code: spokenCode(row, code),
      })}
    >
      <span className="scan-history__time">{timeOf(row.scannedAt)}</span>
      <span className="scan-history__operator" title={operator}>
        {operator}
      </span>
      <span className="scan-history__position">{position}</span>
      <span className="scan-history__result">
        <StatusChip phase={PHASE[row.verdict]} size="floor" label={result.label} />
        {result.reason !== null && <span className="scan-history__reason">{result.reason}</span>}
      </span>
      <span className="scan-history__code">
        <ScanCode gtin14={row.gtin14} serial={row.serial} size="full" fallback={code} />
      </span>
    </li>
  );
}

/** The columns' names, said once for a screen reader and shown above the rows. */
function HistoryHead() {
  const { t } = useTranslation();
  return (
    <div className="scan-history__head" aria-hidden="true">
      <span>{t("floor.scanHistory.time")}</span>
      <span>{t("floor.scanHistory.operator")}</span>
      <span>{t("floor.scanHistory.position")}</span>
      <span>{t("floor.scanHistory.result")}</span>
      <span>{t("floor.scanHistory.code")}</span>
    </div>
  );
}

export type ScanHistoryRead =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; rows: ScanHistoryRow[]; total: number };
type Read = ScanHistoryRead;

/**
 * One slice of the shift's scans, read again when `refreshKey` changes (the
 * work screen changes it after every scan). A failed read leaves the old rows
 * out and says so; it never touches the work itself.
 */
export function useScanHistory(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
  limit: number,
  offset: number,
  refreshKey: unknown,
  enabled: boolean,
): Read {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const { hostId, deviceId } = pairing;
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    readScanHistory(local, { hostId, deviceId }, shiftId, { limit, offset }).then(
      (next) => {
        if (!cancelled) setRead({ kind: "ready", ...next });
      },
      () => {
        if (!cancelled) setRead({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId, limit, offset, refreshKey, enabled]);
  return read;
}

/** One row of the work screen's list: the time, the result as a chip with its glyph, the code. */
function CompactRow({ row }: { row: ScanHistoryRow }) {
  const { t } = useTranslation();
  const result = useResult()(row);
  const operator = row.operatorName ?? t("floor.scanHistory.noOperator");
  const position =
    row.boxPosition === null
      ? t("floor.scanHistory.noBox")
      : t("floor.scanHistory.position_n", { n: row.boxPosition });
  const code = row.maskedCode ?? t("floor.scanHistory.noCode");
  return (
    <li
      className="scan-history__row"
      data-verdict={row.verdict}
      aria-label={t("floor.scanHistory.row", {
        time: timeOf(row.scannedAt),
        operator,
        position,
        result: result.reason === null ? result.label : `${result.label}: ${result.reason}`,
        code: spokenCode(row, code),
      })}
    >
      <span className="scan-history__time">{timeOf(row.scannedAt)}</span>
      <span className="scan-history__result">
        <StatusChip phase={PHASE[row.verdict]} size="floor" label={result.label} />
      </span>
      <span className="scan-history__code">
        <ScanCode gtin14={row.gtin14} serial={row.serial} fallback={code} />
      </span>
    </li>
  );
}

export interface ScanHistoryProps {
  /** The screen's one read of the newest scans (`useScanHistory`), also the last scan's source. */
  read: ScanHistoryRead;
  /** Opens the full history. */
  onOpenAll: () => void;
}

/**
 * «История сканирований» on the work screen: the shift's one list of its last
 * `COMPACT_ROWS` scans (time, result, code), and a button for all of them. The list
 * scrolls inside its own region; nothing else on the screen does.
 */
export function ScanHistory({ read, onOpenAll }: ScanHistoryProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  const rowCount = read.kind === "ready" ? read.rows.length : 0;
  const fit = useWholeRows(listRef, rowCount);
  const visible = read.kind === "ready" ? read.rows.slice(0, fit ?? rowCount) : [];
  return (
    <section
      className="work-instrument scan-history scan-history--compact"
      aria-labelledby="scan-history-title"
    >
      <div className="scan-history__title">
        <h2 id="scan-history-title">{t("floor.scanHistory.title")}</h2>
        <Button size="floor" variant="secondary" onClick={onOpenAll}>
          {t("floor.scanHistory.all")}
        </Button>
      </div>
      {read.kind === "failed" && <Alert tone="warn">{t("floor.scanHistory.failed")}</Alert>}
      {read.kind === "ready" && read.rows.length === 0 && (
        <p className="scan-history__empty">{t("floor.scanHistory.empty")}</p>
      )}
      {read.kind === "ready" && read.rows.length > 0 && (
        <ul ref={listRef} className="scan-history__list" aria-label={t("floor.scanHistory.title")}>
          {visible.map((row) => (
            <CompactRow key={row.id} row={row} />
          ))}
        </ul>
      )}
      {read.kind === "ready" && read.total > visible.length && (
        <p className="scan-history__note">
          {t("floor.scanHistory.shown", { count: visible.length })}
        </p>
      )}
    </section>
  );
}

export interface ScanHistoryScreenProps {
  local: LocalExecutor;
  pairing: Pairing;
  shiftId: string;
  refreshKey: unknown;
  onBack: () => void;
}

/** The full history: every scan of the shift, newest first, `PAGE_ROWS` to a page. */
export function ScanHistoryScreen({
  local,
  pairing,
  shiftId,
  refreshKey,
  onBack,
}: ScanHistoryScreenProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const read = useScanHistory(
    local,
    pairing,
    shiftId,
    PAGE_ROWS,
    page * PAGE_ROWS,
    refreshKey,
    true,
  );
  const total = read.kind === "ready" ? read.total : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_ROWS));
  return (
    <section className="scan-history scan-history--full" aria-labelledby="scan-history-full-title">
      <h2 id="scan-history-full-title">{t("floor.scanHistory.title")}</h2>
      {read.kind === "failed" && <Alert tone="warn">{t("floor.scanHistory.failed")}</Alert>}
      {read.kind === "loading" && <p>{t("floor.scanHistory.loading")}</p>}
      {read.kind === "ready" && read.rows.length === 0 && (
        <p className="scan-history__empty">{t("floor.scanHistory.empty")}</p>
      )}
      {read.kind === "ready" && read.rows.length > 0 && (
        <>
          <HistoryHead />
          <ul className="scan-history__list" aria-label={t("floor.scanHistory.title")}>
            {read.rows.map((row) => (
              <HistoryRow key={row.id} row={row} />
            ))}
          </ul>
        </>
      )}
      <div className="scan-history__pager">
        <Button
          size="floor"
          variant="secondary"
          disabled={page === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          {t("floor.scanHistory.previous")}
        </Button>
        <span className="scan-history__page">
          {t("floor.scanHistory.page", { page: page + 1, pages })}
        </span>
        <Button
          size="floor"
          variant="secondary"
          disabled={page + 1 >= pages}
          onClick={() => setPage((current) => current + 1)}
        >
          {t("floor.scanHistory.next")}
        </Button>
        <Button size="floor" onClick={onBack}>
          {t("floor.scanHistory.back")}
        </Button>
      </div>
    </section>
  );
}
