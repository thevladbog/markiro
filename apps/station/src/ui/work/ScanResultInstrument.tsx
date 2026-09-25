import type { RecentOperation } from "../../lib/journal.js";

export interface ScanResultLabels {
  waiting: string;
  ok: string;
  duplicate: string;
  invalid: string;
  wrong_gtin: string;
  unknown: string;
  gtin: string;
  serial: string;
  crypto: string;
}

export interface ScanResultInstrumentProps {
  operation: RecentOperation | null;
  labels: ScanResultLabels;
}

export function operationStatusLabel(verdict: string, labels: ScanResultLabels): string {
  if (verdict === "ok") return labels.ok;
  if (verdict === "duplicate") return labels.duplicate;
  if (verdict === "invalid") return labels.invalid;
  if (verdict === "wrong_gtin") return labels.wrong_gtin;
  return labels.unknown;
}

/**
 * The validation verdict. Product identity lives in the shift band
 * (`ShiftBand.tsx`); aggregation shows its accepted serial in the box instrument.
 */
export function ScanResultInstrument({ operation, labels }: ScanResultInstrumentProps) {
  return (
    <section className="work-instrument work-scan-result">
      <ScanVerdict operation={operation} labels={labels} />
    </section>
  );
}

function ScanVerdict({
  operation,
  labels,
}: {
  operation: RecentOperation | null;
  labels: ScanResultLabels;
}) {
  const displayCode = operation?.identity
    ? `(01)${operation.identity.gtin14} (21)${operation.identity.serial}`
    : "";
  const tone = operation?.verdict === "ok" ? "ok" : operation ? "error" : "neutral";
  return (
    <div
      className="work-scan-result__verdict"
      role="status"
      data-tone={tone}
      data-compact-success={tone === "ok" && operation?.identity ? "true" : undefined}
      aria-label={tone === "ok" && operation?.identity ? `${labels.ok}: ${displayCode}` : undefined}
    >
      {tone === "ok" && operation?.identity ? (
        <>
          <span
            className="work-scan-result__accepted-marker"
            data-semantic="accepted-marker"
            aria-hidden="true"
          >
            ✓
          </span>
          <code className="work-scan-result__normalized" data-semantic="normalized-code">
            {displayCode}
          </code>
        </>
      ) : (
        <strong>
          {operation ? operationStatusLabel(operation.verdict, labels) : labels.waiting}
        </strong>
      )}
      {tone !== "ok" && operation?.codeSuffix ? <span>{operation.codeSuffix}</span> : null}
    </div>
  );
}
