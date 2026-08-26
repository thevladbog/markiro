import { Button } from "@markiro/ui";

export interface RepackCorrectionsProps {
  itemCount: number;
  invalidated: boolean;
  busy: boolean;
  onRemoveLast: () => void;
  onClear: () => void;
  onResolveConflict: () => void;
  reprintSscc: string;
  onReprintSsccChange: (value: string) => void;
  onFindReprint: () => void;
  reprintCandidate: { sscc: string; quantity: number; productionDate: string } | null;
  reprintError: boolean;
  onReprint: () => void;
  labels: {
    removeLast: string;
    clear: string;
    resolveConflict: string;
    empty: string;
    reprintTitle: string;
    reprintSscc: string;
    findReprint: string;
    reprintCandidate: string;
    reprintMissing: string;
    reprint: string;
    quantity: string;
    productionDate: string;
  };
}

export function RepackCorrections({
  itemCount,
  invalidated,
  busy,
  onRemoveLast,
  onClear,
  onResolveConflict,
  reprintSscc,
  onReprintSsccChange,
  onFindReprint,
  reprintCandidate,
  reprintError,
  onReprint,
  labels,
}: RepackCorrectionsProps) {
  return (
    <div className="repack-corrections">
      <section>
        {invalidated ? (
          <Button size="floor" variant="secondary" disabled={busy} onClick={onResolveConflict}>
            {labels.resolveConflict}
          </Button>
        ) : itemCount === 0 ? (
          <p>{labels.empty}</p>
        ) : (
          <div className="repack-corrections__open-box">
            <Button size="floor" variant="secondary" disabled={busy} onClick={onRemoveLast}>
              {labels.removeLast}
            </Button>
            <Button size="floor" variant="secondary" disabled={busy} onClick={onClear}>
              {labels.clear}
            </Button>
          </div>
        )}
      </section>
      <section className="repack-reprint">
        <h3>{labels.reprintTitle}</h3>
        <div className="repack-reprint__lookup">
          <label htmlFor="inventory-reprint-sscc">{labels.reprintSscc}</label>
          <input
            id="inventory-reprint-sscc"
            inputMode="numeric"
            maxLength={18}
            value={reprintSscc}
            onChange={(event) =>
              onReprintSsccChange(event.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 18))
            }
          />
          <Button
            size="floor"
            variant="secondary"
            disabled={busy || reprintSscc.length !== 18}
            onClick={onFindReprint}
          >
            {labels.findReprint}
          </Button>
        </div>
        {reprintError ? <p role="alert">{labels.reprintMissing}</p> : null}
        {reprintCandidate ? (
          <div className="repack-reprint__candidate">
            <strong>{labels.reprintCandidate}</strong>
            <span>{reprintCandidate.sscc}</span>
            <span>
              {labels.quantity}: {reprintCandidate.quantity}
            </span>
            <span>
              {labels.productionDate}: {reprintCandidate.productionDate}
            </span>
            <Button size="floor" disabled={busy} onClick={onReprint}>
              {labels.reprint}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
