import { Button } from "@markiro/ui";

export interface BoxFillLabels {
  title: string;
  absent: string;
  count: string;
  capacityUnknown: string;
  close: string;
  undo: string;
  clear: string;
}

export interface BoxFillInstrumentProps {
  box: { boxId: string; itemCount: number } | null;
  capacity: number | null;
  canUndo: boolean;
  closeDisabled?: boolean;
  labels: BoxFillLabels;
  onClose: () => void;
  onUndo: () => void;
  onClear: () => void;
}

export function BoxFillInstrument({
  box,
  capacity,
  canUndo,
  closeDisabled = false,
  labels,
  onClose,
  onUndo,
  onClear,
}: BoxFillInstrumentProps) {
  const usableCapacity = capacity !== null && capacity > 0 ? capacity : null;
  const fill = box && usableCapacity ? Math.min(box.itemCount, usableCapacity) : 0;
  return (
    <section className="work-instrument work-box-fill" aria-labelledby="work-box-fill-title">
      <h2 id="work-box-fill-title">{labels.title}</h2>
      {box ? (
        <>
          <div className="work-box-fill__readout">
            <strong data-testid="box-progress">
              {usableCapacity ? `${box.itemCount} / ${usableCapacity}` : box.itemCount}
            </strong>
            <span>{usableCapacity ? labels.count : labels.capacityUnknown}</span>
          </div>
          {usableCapacity ? (
            <div
              className="work-box-fill__track"
              role="progressbar"
              aria-label={labels.title}
              aria-valuemin={0}
              aria-valuemax={usableCapacity}
              aria-valuenow={fill}
            >
              <span style={{ width: `${(fill / usableCapacity) * 100}%` }} />
            </div>
          ) : null}
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
