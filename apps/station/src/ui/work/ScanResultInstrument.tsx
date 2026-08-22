import type { CSSProperties } from "react";
import type { RecentOperation } from "../../lib/journal.js";
import type { SqlExecutor, StationProductImageDescriptor } from "../../lib/mirror.js";
import { useProductAccentHue } from "../../lib/product-accent.js";
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
  plannedQty?: number | null | undefined;
  planLabel?: string | undefined;
  operation: RecentOperation | null;
  labels: ScanResultLabels;
  exec?: SqlExecutor | undefined;
  productId?: string | undefined;
  image?: StationProductImageDescriptor | null | undefined;
  /** Expected GTIN-14 of the shift's product; prints as a chip and seeds the fallback accent hue. */
  gtin?: string | null | undefined;
  refreshKey?: number;
  /**
   * False when an aggregation shift shows the accepted-scan readout inside the
   * box instrument instead (BoxFillInstrument's `lastAccepted`) — this card
   * then renders the product identity alone, so the screen never carries two
   * live verdict regions.
   */
  showVerdict?: boolean;
}

export function operationStatusLabel(verdict: string, labels: ScanResultLabels): string {
  if (verdict === "ok") return labels.ok;
  if (verdict === "duplicate") return labels.duplicate;
  if (verdict === "invalid") return labels.invalid;
  if (verdict === "wrong_gtin") return labels.wrong_gtin;
  return labels.unknown;
}

/** «Балтика 7…» → «Б». The photo slot's stand-in when the product has no photo. */
export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? ([...first.toUpperCase()][0] ?? "?") : "?";
}

export function ScanResultInstrument({
  productName,
  counterpartyName,
  plannedQty,
  planLabel,
  operation,
  labels,
  exec,
  productId,
  image,
  gtin,
  refreshKey,
  showVerdict = true,
}: ScanResultInstrumentProps) {
  const hue = useProductAccentHue({ exec, productId, image, gtin, refreshKey });
  const heroStyle = hue === null ? undefined : ({ "--product-hue": String(hue) } as CSSProperties);
  return (
    <section
      className="work-instrument work-scan-result"
      aria-label={productName}
      data-identity-only={showVerdict ? undefined : "true"}
    >
      <div
        className="work-scan-result__identity"
        data-accent={hue === null ? undefined : "true"}
        style={heroStyle}
      >
        {productId && image !== null ? (
          <ProductImage
            exec={exec}
            productId={productId}
            productName={productName}
            image={image}
            refreshKey={refreshKey}
            className="work-scan-result__image"
          />
        ) : (
          <span aria-hidden="true" className="work-scan-result__image work-scan-result__monogram">
            {productMonogram(productName)}
          </span>
        )}
        <div className="work-scan-result__copy">
          <h2 title={productName}>{productName}</h2>
          <div className="work-scan-result__chips">
            {planLabel && plannedQty !== null && plannedQty !== undefined ? (
              <span className="work-scan-result__chip">{`${planLabel}: ${plannedQty}`}</span>
            ) : null}
            {counterpartyName ? (
              <span className="work-scan-result__chip" title={counterpartyName}>
                {counterpartyName}
              </span>
            ) : null}
            {gtin ? (
              <span className="work-scan-result__chip work-scan-result__chip--mono">
                {`${labels.gtin} ${gtin}`}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {showVerdict ? <ScanVerdict operation={operation} labels={labels} /> : null}
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
  const tone = operation?.verdict === "ok" ? "ok" : operation ? "error" : "neutral";
  return (
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
  );
}
