import type { RecentOperation } from "../../lib/journal.js";
import type { SqlExecutor, StationProductImageDescriptor } from "../../lib/mirror.js";
import { ProductImage } from "../ProductImage.js";

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
  productName: string;
  counterpartyName: string | null;
  operation: RecentOperation | null;
  labels: ScanResultLabels;
  exec?: SqlExecutor | undefined;
  productId?: string | undefined;
  image?: StationProductImageDescriptor | null | undefined;
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
  exec,
  productId,
  image,
}: ScanResultInstrumentProps) {
  const tone = operation?.verdict === "ok" ? "ok" : operation ? "error" : "neutral";
  return (
    <section className="work-instrument work-scan-result" aria-label={productName}>
      <div className="work-scan-result__identity">
        {productId ? <ProductImage exec={exec} productId={productId} productName={productName} image={image} className="work-scan-result__image" /> : null}
        <h2 title={productName}>{productName}</h2>
        {counterpartyName ? <p title={counterpartyName}>{counterpartyName}</p> : null}
      </div>
      <div
        className="work-scan-result__verdict"
        role="status"
        data-tone={tone}
        data-compact-success={tone === "ok" && operation?.identity ? "true" : undefined}
        aria-label={
          tone === "ok" && operation?.identity
            ? `${labels.ok}: ${operation.identity.normalized}`
            : undefined
        }
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
              {operation.identity.normalized}
            </code>
          </>
        ) : (
          <strong>
            {operation ? operationStatusLabel(operation.verdict, labels) : labels.waiting}
          </strong>
        )}
        {tone !== "ok" && operation?.codeSuffix ? <span>{operation.codeSuffix}</span> : null}
      </div>
    </section>
  );
}
