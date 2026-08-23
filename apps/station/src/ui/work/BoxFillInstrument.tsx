import { Button } from "@markiro/ui";

export interface BoxFillLabels {
  title: string;
  number: string;
  absent: string;
  count: string;
  capacityUnknown: string;
  grouped: string;
  close: string;
  undo: string;
  clear: string;
}

export interface BoxFillInstrumentProps {
  box: { boxId: string; itemCount: number } | null;
  ordinal: number | null;
  acceptedToken: string | null;
  capacity: number | null;
  canUndo: boolean;
  closeDisabled?: boolean;
  labels: BoxFillLabels;
  /**
   * The latest accepted scan, printed beside the readout as «✓ serial». The
   * serial alone identifies the bottle to a worker mid-box; the full
   * normalized code stays in the recent-operations list. When given (non-
   * undefined), this instrument owns the screen's accepted-scan live region —
   * the caller must pass `showVerdict={false}` to its ScanResultInstrument.
   */
  lastAccepted?: { serial: string } | null;
  /** Labels for the accepted readout; required whenever lastAccepted is used. */
  verdictLabels?: { ok: string; waiting: string };
  onClose: () => void;
  onUndo: () => void;
  onClear: () => void;
}

export type BoxFillPersistentState = "empty" | "partial" | "full";

export interface BoxCell {
  from: number;
  to: number;
  state: "filled" | "partial" | "next" | "empty";
}

export function buildBoxCells(filled: number, capacity: number): BoxCell[] {
  const size = capacity <= 100 ? 1 : Math.ceil(capacity / 100);
  const cells: BoxCell[] = [];
  for (let from = 1; from <= capacity; from += size) {
    const to = Math.min(capacity, from + size - 1);
    const state =
      filled >= to
        ? "filled"
        : filled >= from
          ? "partial"
          : filled + 1 >= from && filled + 1 <= to
            ? "next"
            : "empty";
    cells.push({ from, to, state });
  }
  return cells;
}

export function boxFillPersistentState(
  box: { itemCount: number } | null,
  capacity: number | null,
): BoxFillPersistentState {
  if (!box || box.itemCount === 0) return "empty";
  if (capacity !== null && capacity > 0 && box.itemCount >= capacity) return "full";
  return "partial";
}

export function BoxFillInstrument({
  box,
  ordinal,
  acceptedToken,
  capacity,
  canUndo,
  closeDisabled = false,
  labels,
  lastAccepted,
  verdictLabels,
  onClose,
  onUndo,
  onClear,
}: BoxFillInstrumentProps) {
  const usableCapacity = capacity !== null && capacity > 0 ? capacity : null;
  const fill = box && usableCapacity ? Math.min(box.itemCount, usableCapacity) : 0;
  const cells = usableCapacity ? buildBoxCells(fill, usableCapacity) : [];
  const grouped = usableCapacity !== null && usableCapacity > 100;
  // A box of ten or fewer gets one row of large numbered segments readable
  // from across the line, instead of a strip of ten small squares.
  const large = usableCapacity !== null && usableCapacity <= 10;
  const rowCount = Math.ceil(cells.length / 10);
  const persistentState = boxFillPersistentState(box, capacity);
  return (
    <section
      className="work-instrument work-box-fill"
      aria-labelledby="work-box-fill-title"
      data-grouped={grouped}
      data-persistent-state={persistentState}
    >
      <h2 id="work-box-fill-title">{box && ordinal !== null ? labels.number : labels.title}</h2>
      {box ? (
        <>
          <div className="work-box-fill__readout">
            <strong data-testid="box-progress">
              {usableCapacity ? `${box.itemCount} / ${usableCapacity}` : box.itemCount}
            </strong>
            <span>{usableCapacity ? labels.count : labels.capacityUnknown}</span>
            {verdictLabels ? (
              <div
                className="work-box-fill__last"
                role="status"
                data-tone={lastAccepted ? "ok" : "neutral"}
                aria-label={
                  lastAccepted ? `${verdictLabels.ok}: ${lastAccepted.serial}` : undefined
                }
              >
                {lastAccepted ? (
                  <>
                    <span aria-hidden="true">✓</span>
                    <code data-semantic="accepted-serial">{lastAccepted.serial}</code>
                  </>
                ) : (
                  <span>{verdictLabels.waiting}</span>
                )}
              </div>
            ) : null}
          </div>
          {usableCapacity ? (
            <div
              className="work-box-fill__grid"
              data-dense={cells.length > 20}
              data-grouped={grouped}
              data-large={large ? "true" : undefined}
              style={{
                gridTemplateRows: `repeat(${rowCount}, minmax(0, 1fr))`,
                ...(large
                  ? { gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }
                  : {}),
              }}
              role="progressbar"
              aria-label={labels.title}
              aria-valuemin={0}
              aria-valuemax={usableCapacity}
              aria-valuenow={fill}
              aria-valuetext={`${box.itemCount} / ${usableCapacity}`}
            >
              {cells.map((cell) => {
                const isLatest =
                  acceptedToken !== null && fill > 0 && fill >= cell.from && fill <= cell.to;
                return (
                  <span
                    key={`${cell.from}:${isLatest ? acceptedToken : "stable"}`}
                    className="work-box-fill__cell"
                    data-state={cell.state}
                    data-latest={isLatest ? "true" : undefined}
                    aria-label={cell.from === cell.to ? `${cell.from}` : `${cell.from}–${cell.to}`}
                    aria-hidden="true"
                  >
                    {large ? cell.from : null}
                  </span>
                );
              })}
            </div>
          ) : null}
          {grouped ? <p className="work-box-fill__grouped">{labels.grouped}</p> : null}
          <div className="work-box-fill__actions">
            <Button size="floor" variant="secondary" disabled={closeDisabled} onClick={onClose}>
              {labels.close}
            </Button>
            {canUndo ? (
              <Button size="floor" variant="secondary" onClick={onUndo}>
                {labels.undo}
              </Button>
            ) : null}
            <Button size="floor" variant="secondary" onClick={onClear}>
              {labels.clear}
            </Button>
          </div>
        </>
      ) : (
        <p className="work-box-fill__empty">{labels.absent}</p>
      )}
    </section>
  );
}
