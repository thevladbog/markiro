import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, StatusChip, type TagPhase } from "@markiro/ui";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { readScanHistory, type ScanHistoryRow } from "./scan-history.js";
import "./scan-history.css";

/** Rows in the work screen's own list: the last scans, with «Вся история» for the rest. */
export const COMPACT_ROWS = 4;
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
        code,
      })}
    >
      <span className="scan-history__time">{timeOf(row.scannedAt)}</span>
      <span className="scan-history__operator" title={operator}>
        {operator}
      </span>
      <span className="scan-history__position">{position}</span>
      <span className="scan-history__result">
        <StatusChip phase={PHASE[row.verdict]} size="office" label={result.label} />
        {result.reason !== null && <span className="scan-history__reason">{result.reason}</span>}
      </span>
      <span className="scan-history__code">{code}</span>
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

type Read =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; rows: ScanHistoryRow[]; total: number };

/**
 * One slice of the shift's scans, read again when `refreshKey` changes (the
 * work screen changes it after every scan). A failed read leaves the old rows
 * out and says so; it never touches the work itself.
 */
function useScanHistory(
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

export interface ScanHistoryProps {
  local: LocalExecutor;
  pairing: Pairing;
  shiftId: string;
  /** Changes after each scan, so the list reads again. */
  refreshKey: unknown;
  /**
   * The screen has read its own state: the history is secondary and reads after it, so a
   * failed first read stops the line as it did, whatever the history asks.
   */
  enabled?: boolean;
  /** Opens the full history. */
  onOpenAll: () => void;
}

/**
 * «История сканирования» on the work screen (beta 3.2, in the place of the
 * duplicated plan row): the last scans of this shift with the time, the
 * operator, the place in the box and the result, and a button for all of them.
 */
export function ScanHistory({
  local,
  pairing,
  shiftId,
  refreshKey,
  enabled = true,
  onOpenAll,
}: ScanHistoryProps) {
  const { t } = useTranslation();
  const read = useScanHistory(local, pairing, shiftId, COMPACT_ROWS, 0, refreshKey, enabled);
  return (
    <section className="scan-history" aria-labelledby="scan-history-title">
      <div className="scan-history__title">
        <h3 id="scan-history-title">{t("floor.scanHistory.title")}</h3>
        <Button size="floor" variant="secondary" onClick={onOpenAll}>
          {t("floor.scanHistory.all")}
        </Button>
      </div>
      {read.kind === "failed" && <Alert tone="warn">{t("floor.scanHistory.failed")}</Alert>}
      {read.kind === "ready" && read.rows.length === 0 && (
        <p className="scan-history__empty">{t("floor.scanHistory.empty")}</p>
      )}
      {read.kind === "ready" && read.rows.length > 0 && (
        <ul className="scan-history__list" aria-label={t("floor.scanHistory.title")}>
          {read.rows.map((row) => (
            <HistoryRow key={row.id} row={row} />
          ))}
        </ul>
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
