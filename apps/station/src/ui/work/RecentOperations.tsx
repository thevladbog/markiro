import type { RecentOperation } from "../../lib/journal.js";
import { operationStatusLabel, type ScanResultLabels } from "./ScanResultInstrument.js";

export interface RecentOperationsProps {
  operations: RecentOperation[];
  /** This terminal's shift counts from the local journal (`readShiftJournalCounts`). */
  counts: { errors: number; duplicates: number };
  labels: {
    title: string;
    empty: string;
    invalidTime: string;
    errors: string;
    duplicates: string;
  };
  statusLabels: ScanResultLabels;
  locale: string;
}

export function RecentOperations({
  operations,
  counts,
  labels,
  statusLabels,
  locale,
}: RecentOperationsProps) {
  const visible = operations.slice(0, 6);
  const number = new Intl.NumberFormat(locale);
  return (
    <section className="work-instrument work-recent" aria-labelledby="work-recent-title">
      <div className="work-recent__head">
        <h2 id="work-recent-title">{labels.title}</h2>
        <dl className="work-recent__quality">
          <div>
            <dt>{labels.errors}</dt>
            <dd data-testid="journal-errors">{number.format(counts.errors)}</dd>
          </div>
          <div>
            <dt>{labels.duplicates}</dt>
            <dd
              data-testid="journal-duplicates"
              data-tone={counts.duplicates > 0 ? "warn" : undefined}
            >
              {number.format(counts.duplicates)}
            </dd>
          </div>
        </dl>
      </div>
      {visible.length === 0 ? (
        <p className="work-recent__empty">{labels.empty}</p>
      ) : (
        <ol>
          {visible.map((operation, index) => (
            <li
              key={`${operation.scannedAt ?? "invalid"}:${index}`}
              data-tone={
                operation.verdict === "ok"
                  ? "ok"
                  : operation.verdict === "undone"
                    ? "neutral"
                    : "error"
              }
            >
              <strong>{operationStatusLabel(operation.verdict, statusLabels)}</strong>
              {operation.identity ? (
                <span className="work-recent__identity">
                  <code
                    className="work-recent__serial"
                    title={`${statusLabels.serial}: ${operation.identity.serial}`}
                  >
                    {operation.identity.serial}
                  </code>
                  {operation.verdict === "wrong_gtin" ? (
                    <span className="work-recent__gtin">
                      {`${statusLabels.gtin} ${operation.identity.gtin14}`}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span>{operation.codeSuffix ?? "—"}</span>
              )}
              <time dateTime={operation.scannedAt ?? undefined}>
                {operation.scannedAt
                  ? new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(
                      new Date(operation.scannedAt),
                    )
                  : labels.invalidTime}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
