import type { CSSProperties } from "react";
import type { SqlExecutor, StationProductImageDescriptor } from "../../lib/mirror.js";
import { useProductAccentHue } from "../../lib/product-accent.js";
import type { ShiftTotalView } from "../../lib/shift-progress.js";
import { ProductImage } from "../ProductImage.js";

export interface ShiftBandLabels {
  gtin: string;
  counterpartyPrefix: string;
  totalAll: string;
  totalTerminal: string;
  planPercent: (percent: string) => string;
  terminalShare: (value: string) => string;
  othersAsOf: (time: string) => string;
}

export interface ShiftBandProps {
  productName: string;
  counterpartyName: string | null;
  /** Expected GTIN-14 of the shift's product; prints as a chip and seeds the fallback accent hue. */
  gtin?: string | null | undefined;
  exec?: SqlExecutor | undefined;
  productId?: string | undefined;
  image?: StationProductImageDescriptor | null | undefined;
  refreshKey?: number;
  total: ShiftTotalView;
  locale: string;
  labels: ShiftBandLabels;
}

/** «Балтика 7…» → «Б». The photo slot's stand-in when the product has no photo. */
export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? ([...first.toUpperCase()][0] ?? "?") : "?";
}

/**
 * What the shift makes and how much of it is made (design 2026-09-25): the
 * product identity on its tinted gradient, and the shift total across
 * terminals against the plan. It spans both work columns.
 */
export function ShiftBand({
  productName,
  counterpartyName,
  gtin,
  exec,
  productId,
  image,
  refreshKey,
  total,
  locale,
  labels,
}: ShiftBandProps) {
  const hue = useProductAccentHue({ exec, productId, image, gtin, refreshKey });
  const style = hue === null ? undefined : ({ "--product-hue": String(hue) } as CSSProperties);
  const number = new Intl.NumberFormat(locale);
  const scopeLabel = total.scope === "all" ? labels.totalAll : labels.totalTerminal;
  const percent =
    total.planned === null
      ? null
      : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
          total.total / total.planned,
        );
  const share =
    total.othersAsOf !== null
      ? labels.othersAsOf(
          new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
            new Date(total.othersAsOf),
          ),
        )
      : total.terminal !== null
        ? labels.terminalShare(number.format(total.terminal))
        : null;
  const meta = [percent === null ? null : labels.planPercent(percent), share]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <section
      className="work-shift-band"
      aria-label={productName}
      data-accent={hue === null ? undefined : "true"}
      style={style}
    >
      {productId && image !== null ? (
        <ProductImage
          exec={exec}
          productId={productId}
          productName={productName}
          image={image}
          refreshKey={refreshKey}
          className="work-shift-band__image"
        />
      ) : (
        <span aria-hidden="true" className="work-shift-band__image work-shift-band__monogram">
          {productMonogram(productName)}
        </span>
      )}
      <div className="work-shift-band__copy">
        <h2 title={productName}>{productName}</h2>
        <div className="work-shift-band__chips">
          {gtin ? (
            <span className="work-shift-band__chip work-shift-band__chip--mono">
              {`${labels.gtin} ${gtin}`}
            </span>
          ) : null}
          {counterpartyName ? (
            <span className="work-shift-band__chip" title={counterpartyName}>
              {`${labels.counterpartyPrefix} ${counterpartyName}`}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="work-shift-band__total"
        role="group"
        aria-label={scopeLabel}
        data-scope={total.scope}
      >
        <p className="work-shift-band__label">{scopeLabel}</p>
        <p className="work-shift-band__value">
          <strong data-testid="shift-total">{number.format(total.total)}</strong>
          {total.planned === null ? null : <span>{`/ ${number.format(total.planned)}`}</span>}
        </p>
        {total.planned === null || total.planRatio === null ? null : (
          <div
            className="work-shift-band__bar"
            role="progressbar"
            aria-label={scopeLabel}
            aria-valuemin={0}
            aria-valuemax={total.planned}
            aria-valuenow={Math.min(total.total, total.planned)}
            aria-valuetext={`${number.format(total.total)} / ${number.format(total.planned)}`}
          >
            <span style={{ width: `${Math.round(total.planRatio * 1000) / 10}%` }} />
          </div>
        )}
        {meta ? <p className="work-shift-band__meta">{meta}</p> : null}
      </div>
    </section>
  );
}
