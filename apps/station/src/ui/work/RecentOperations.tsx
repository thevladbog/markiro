import type { RecentOperation } from "../../lib/journal.js";
import { operationStatusLabel, type ScanResultLabels } from "./ScanResultInstrument.js";

export interface RecentOperationsProps {
  operations: RecentOperation[];
  labels: { title: string; empty: string; invalidTime: string };
  statusLabels: ScanResultLabels;
  locale: string;
}

export function RecentOperations({
  operations,
  labels,
  statusLabels,
  locale,
}: RecentOperationsProps) {
  const visible = operations.slice(0, 6);
  return (
    <section className="work-instrument work-recent" aria-labelledby="work-recent-title">
      <h2 id="work-recent-title">{labels.title}</h2>
      {visible.length === 0 ? (
        <p className="work-recent__empty">{labels.empty}</p>
      ) : (
        <ol>
          {visible.map((operation, index) => (
            <li
              key={`${operation.scannedAt ?? "invalid"}:${index}`}
              data-tone={operation.verdict === "ok" ? "ok" : "error"}
            >
              <strong>{operationStatusLabel(operation.verdict, statusLabels)}</strong>
              {operation.identity ? (
                <dl className="work-recent__identity">
                  <div>
                    <dt>{statusLabels.gtin}</dt>
                    <dd>{operation.identity.gtin14}</dd>
                  </div>
                  <div>
                    <dt>{statusLabels.serial}</dt>
                    <dd>{operation.identity.serial}</dd>
                  </div>
                </dl>
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
