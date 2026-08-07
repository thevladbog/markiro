import type { RecentOperation } from "../../lib/journal.js";

export interface ScanResultLabels {
  waiting: string;
  ok: string;
  duplicate: string;
  invalid: string;
  wrong_gtin: string;
  unknown: string;
}

export interface ScanResultInstrumentProps {
  productName: string;
  counterpartyName: string | null;
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

export function ScanResultInstrument({
  productName,
  counterpartyName,
  operation,
  labels,
}: ScanResultInstrumentProps) {
  const tone = operation?.verdict === "ok" ? "ok" : operation ? "error" : "neutral";
  return (
    <section className="work-instrument work-scan-result" aria-label={productName}>
      <div className="work-scan-result__identity">
        <h2 title={productName}>{productName}</h2>
        {counterpartyName ? <p title={counterpartyName}>{counterpartyName}</p> : null}
      </div>
      <div className="work-scan-result__verdict" role="status" data-tone={tone}>
        <strong>
          {operation ? operationStatusLabel(operation.verdict, labels) : labels.waiting}
        </strong>
        {operation?.codeSuffix ? <span>{operation.codeSuffix}</span> : null}
      </div>
    </section>
  );
}
