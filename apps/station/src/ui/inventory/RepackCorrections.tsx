import { Button, PinPad } from "@markiro/ui";

export interface RepackReprintMatch {
  boxId: string;
  sscc: string;
  quantity: number;
  productionDate: string;
}

export const REPACK_REPRINT_MIN_QUERY = 4;

export interface RepackCorrectionsProps {
  itemCount: number;
  claimLostConflict: boolean;
  compositionBlocked: boolean;
  busy: boolean;
  onRemoveLast: () => void;
  onClear: () => void;
  onResolveConflict: () => void;
  reprintQuery: string;
  onReprintQueryChange: (value: string) => void;
  /** Live matches for the current query; null while the lookup is running. */
  reprintMatches: RepackReprintMatch[] | null;
  onReprint: (match: RepackReprintMatch) => void;
  labels: {
    removeLast: string;
    clear: string;
    resolveConflict: string;
    empty: string;
    openBoxTitle: string;
    reprintTitle: string;
    reprintSscc: string;
    reprintHint: string;
    noMatches: string;
    reprint: string;
    quantity: string;
    keypad: string;
    keypadBackspace: string;
    keypadClear: string;
  };
}

/** Bolds every occurrence of the typed fragment inside a matched SSCC. */
function highlightFragment(sscc: string, fragment: string) {
  if (!fragment) return sscc;
  const parts = sscc.split(fragment);
  if (parts.length === 1) return sscc;
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 ? <mark>{fragment}</mark> : null}
      {part}
    </span>
  ));
}

export function RepackCorrections({
  itemCount,
  claimLostConflict,
  compositionBlocked,
  busy,
  onRemoveLast,
  onClear,
  onResolveConflict,
  reprintQuery,
  onReprintQueryChange,
  reprintMatches,
  onReprint,
  labels,
}: RepackCorrectionsProps) {
  const querySettled = reprintQuery.length >= REPACK_REPRINT_MIN_QUERY;
  return (
    <div className="repack-corrections">
      <section className="repack-corrections__open">
        <h3>{labels.openBoxTitle}</h3>
        {claimLostConflict ? (
          <Button size="floor" variant="secondary" disabled={busy} onClick={onResolveConflict}>
            {labels.resolveConflict}
          </Button>
        ) : compositionBlocked ? null : itemCount === 0 ? (
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
            placeholder="••••"
            value={reprintQuery}
            onChange={(event) =>
              onReprintQueryChange(event.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 18))
            }
          />
          <p className="repack-reprint__hint">{labels.reprintHint}</p>
        </div>
        <div className="repack-reprint__workspace">
          <div className="repack-reprint__keypad">
            <PinPad
              value={reprintQuery}
              onChange={(next) => onReprintQueryChange(next.replace(/[^0-9]/g, "").slice(0, 18))}
              maxLength={18}
              size="floor"
              disabled={busy}
              ariaLabel={labels.keypad}
              backspaceLabel={labels.keypadBackspace}
              clearLabel={labels.keypadClear}
            />
          </div>
          <div className="repack-reprint__results" aria-live="polite">
            {!querySettled ? (
              <p className="repack-reprint__placeholder">{labels.reprintHint}</p>
            ) : reprintMatches === null ? null : reprintMatches.length === 0 ? (
              <p className="repack-reprint__placeholder" role="status">
                {labels.noMatches}
              </p>
            ) : (
              <ul className="repack-reprint__matches">
                {reprintMatches.map((match) => (
                  <li key={match.boxId} className="repack-reprint__match">
                    <div>
                      <strong>{highlightFragment(match.sscc, reprintQuery)}</strong>
                      <span>
                        {labels.quantity}: {match.quantity} · {match.productionDate}
                      </span>
                    </div>
                    <Button size="floor" disabled={busy} onClick={() => onReprint(match)}>
                      {labels.reprint}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
