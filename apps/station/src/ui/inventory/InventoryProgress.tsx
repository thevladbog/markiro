import type {
  InventoryProgress as InventoryProgressValue,
  RecentInventoryOperation,
} from "../../lib/inventory-journal.js";

export interface InventoryProgressLabels {
  verified: string;
  discrepancies: string;
  terminal: string;
  boxes: string;
  items: string;
  recent: string;
  empty: string;
  status: Record<RecentInventoryOperation["verdict"], string>;
  gtin: string;
  serial: string;
  invalidTime: string;
}

export interface InventoryProgressProps {
  progress: InventoryProgressValue;
  recent: RecentInventoryOperation[];
  gtin14: string;
  locale: string;
  labels: InventoryProgressLabels;
  variant?: "summary" | "recent" | "all";
}

export function InventoryProgress({
  progress,
  recent,
  gtin14,
  locale,
  labels,
  variant = "all",
}: InventoryProgressProps) {
  return (
    <>
      {variant !== "recent" ? (
        <section className="inventory-progress-summary" aria-label={labels.verified}>
          <dl>
            <div>
              <dt>{labels.verified}</dt>
              <dd data-testid="inventory-verified">{progress.verified.toLocaleString(locale)}</dd>
            </div>
            <div>
              <dt>{labels.discrepancies}</dt>
              <dd data-testid="inventory-discrepancies">
                {progress.discrepancies.toLocaleString(locale)}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
      {variant !== "summary" ? (
        <section className="inventory-recent" aria-labelledby="inventory-recent-title">
          <h2 id="inventory-recent-title">{labels.recent}</h2>
          {recent.length === 0 ? (
            <p>{labels.empty}</p>
          ) : (
            <ol>
              {recent.slice(0, 6).map((operation) => (
                <li key={operation.eventId} data-verdict={operation.verdict}>
                  <strong>{labels.status[operation.verdict]}</strong>
                  <span>
                    {operation.scanKind === "item"
                      ? `${labels.gtin}: ${gtin14} · ${labels.serial}: ${operation.serialSuffix ?? "—"}`
                      : (operation.ssccSuffix ?? "—")}
                  </span>
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
      ) : null}
      {variant !== "recent" ? (
        <section className="inventory-terminal-progress" aria-label={labels.terminal}>
          <div>
            <strong>{progress.claimedByDevice.toLocaleString(locale)}</strong>
            <span>{labels.terminal}</span>
          </div>
          <div>
            <strong>{progress.acceptedBoxes.toLocaleString(locale)}</strong>
            <span>{labels.boxes}</span>
          </div>
          <div>
            <strong>{progress.acceptedItems.toLocaleString(locale)}</strong>
            <span>{labels.items}</span>
          </div>
        </section>
      ) : null}
    </>
  );
}
