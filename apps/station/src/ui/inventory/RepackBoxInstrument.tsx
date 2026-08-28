import type {
  InventoryRepackScanResult,
  InventoryRepackStateView,
} from "../../lib/inventory-repacking.js";

export interface RepackBoxInstrumentProps {
  state: InventoryRepackStateView;
  result: InventoryRepackScanResult | null;
  writeFailed: boolean;
  capacity: number;
  labels: {
    oldBox: string;
    newBox: string;
    productionDate: string;
    awaiting: string;
    scanning: string;
    pendingPrint: string;
    invalidated: string;
    adminInvalidated: string;
    oldSelected: string;
    accepted: string;
    discrepancy: string;
    writeFailed: string;
    position: (position: number, filled: boolean) => string;
    formatDate: (value: string) => string;
  };
}

export function RepackBoxInstrument({
  state,
  result,
  writeFailed,
  capacity: configuredCapacity,
  labels,
}: RepackBoxInstrumentProps) {
  const box = state.box;
  const prompt =
    state.phase === "awaiting-old-box"
      ? labels.awaiting
      : state.phase === "closed-pending-print"
        ? labels.pendingPrint
        : state.phase === "invalidated"
          ? state.box?.invalidationSource === "admin"
            ? labels.adminInvalidated
            : labels.invalidated
          : labels.scanning;
  const verdict = writeFailed
    ? labels.writeFailed
    : result?.verdict === "old-box-selected"
      ? labels.oldSelected
      : result?.verdict === "expected" || result?.verdict === "capacity-closed"
        ? labels.accepted
        : result
          ? labels.discrepancy
          : null;
  const capacity = box?.capacity ?? configuredCapacity;
  const count = box?.itemCount ?? 0;

  return (
    <section className="repack-instrument" aria-live="polite">
      <div className="repack-box-facts">
        <div>
          <span>{labels.oldBox}</span>
          <strong>{box?.oldSsccContext ?? "—"}</strong>
        </div>
        <div>
          <span>{labels.newBox}</span>
          <strong>{box?.newSscc ?? "—"}</strong>
        </div>
        <div>
          <span>{labels.productionDate}</span>
          <strong>{box?.productionDate ? labels.formatDate(box.productionDate) : "—"}</strong>
        </div>
      </div>
      <div className="repack-capacity" aria-label={`${count} / ${capacity}`}>
        <strong data-testid="repack-count">
          {count} / {capacity}
        </strong>
        <ol>
          {Array.from({ length: capacity }, (_, index) => {
            const filled = index < count;
            return (
              <li
                key={index}
                data-testid="repack-position"
                data-filled={filled}
                aria-label={labels.position(index + 1, filled)}
              >
                {index + 1}
              </li>
            );
          })}
        </ol>
      </div>
      <div className={`repack-prompt repack-prompt--${state.phase}`}>
        <span aria-hidden="true">⌗</span>
        <h2>{prompt}</h2>
        {verdict ? <p role="status">{verdict}</p> : null}
      </div>
    </section>
  );
}
