import type { CSSProperties, ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";

import { Button, type ButtonProps } from "@markiro/ui";

import { hueFromGtin, productMonogram } from "../shifts/product-accent.js";
import { formatQuantity } from "../shifts/shift-text.js";

/*
 * The presentation of the work screen, ported from the cloud station's
 * `ui/work` (ShiftBand, BoxFillInstrument, ScanResultInstrument, WorkFooter;
 * apps/station/src/ui/work). Only the look is ported: what the cloud reads
 * there (a photo, the shift's total across terminals, the journal) the
 * standalone does not have, and the figures come from the work screen.
 */

const PERCENT = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 0 });

export interface ShiftBandProps {
  productName: string;
  gtin: string;
  number: string;
  counterpartyName: string | null;
  /** Codes this station holds in the shift: its actual quantity. */
  accepted: number;
  plannedQty: number | null;
}

/**
 * What the shift makes and how much of it is made: the product on its
 * tinted gradient, the shift's number, and the quantity accepted against the
 * plan (the cloud's `ShiftBand`; the standalone counts this station alone).
 */
export function ShiftBand({
  productName,
  gtin,
  number,
  counterpartyName,
  accepted,
  plannedQty,
}: ShiftBandProps) {
  const { t } = useTranslation();
  const style = { "--product-hue": String(hueFromGtin(gtin)) } as CSSProperties;
  const ratio = plannedQty === null || plannedQty <= 0 ? null : Math.min(1, accepted / plannedQty);
  return (
    <section
      className="work-shift-band"
      aria-label={t("floor.work.product", { name: productName, gtin })}
      data-accent="true"
      style={style}
    >
      <span aria-hidden="true" className="work-shift-band__monogram">
        {productMonogram(productName)}
      </span>
      <div className="work-shift-band__copy">
        <h2 title={productName}>{productName}</h2>
        <div className="work-shift-band__chips">
          <span className="work-shift-band__chip">{t("floor.work.title", { number })}</span>
          <span className="work-shift-band__chip work-shift-band__chip--mono">{`GTIN ${gtin}`}</span>
          {counterpartyName !== null && (
            <span className="work-shift-band__chip" title={counterpartyName}>
              {t("floor.work.layout.counterparty", { name: counterpartyName })}
            </span>
          )}
        </div>
      </div>
      <div className="work-shift-band__total">
        <p className="work-shift-band__label">{t("floor.work.accepted")}</p>
        <p className="work-shift-band__count">{formatQuantity(accepted)}</p>
        {plannedQty === null ? (
          <span />
        ) : (
          <span className="work-shift-band__planned">{`/ ${formatQuantity(plannedQty)}`}</span>
        )}
        {plannedQty !== null && ratio !== null && (
          <>
            <div
              className="work-shift-band__bar"
              role="progressbar"
              aria-label={t("floor.work.accepted")}
              aria-valuemin={0}
              aria-valuemax={plannedQty}
              aria-valuenow={Math.min(accepted, plannedQty)}
              aria-valuetext={`${formatQuantity(accepted)} / ${formatQuantity(plannedQty)}`}
            >
              <span style={{ width: `${Math.round(ratio * 1000) / 10}%` }} />
            </div>
            <p className="work-shift-band__meta">
              {t("floor.work.layout.planPercent", {
                percent: PERCENT.format(accepted / plannedQty),
              })}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * «5 из 12» with the numbers in the counter's mono face and the words in the
 * interface's, as the cloud sets «2 / 20 позиций»; it reads as one phrase
 * (its text is the floor's «N из M»).
 */
export function OfCount({
  quantity,
  capacity,
  unit,
  className,
}: {
  quantity: number;
  capacity: number;
  unit: string | null;
  className: string;
}) {
  const { t } = useTranslation();
  return (
    <strong className={`work-of-count ${className}`}>
      <span className="work-of-count__number">{formatQuantity(quantity)}</span>{" "}
      <span className="work-of-count__word">{t("floor.work.layout.of")}</span>{" "}
      <span className="work-of-count__number">{formatQuantity(capacity)}</span>
      {unit !== null && (
        <>
          {" "}
          <span className="work-of-count__word">{unit}</span>
        </>
      )}
    </strong>
  );
}

export interface BoxCell {
  from: number;
  to: number;
  state: "filled" | "partial" | "next" | "empty";
}

/** The places of a box as cells: one a place up to 100, a group of places past that (the cloud's). */
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

export interface BoxFillProps {
  items: number;
  capacity: number;
  /** Changes with every accepted code: the cell it filled pulses once. */
  acceptedToken: number;
  /** The action row under the cells (the box's close). */
  actions: ReactNode;
}

/**
 * The open box as cells (the cloud's `BoxFillInstrument`): its title and
 * count in one row, a cell a place, the next place outlined, and its action
 * under them. The term and its value stay one after the other («Открытый
 * короб» · «2 из 12»), as the floor's figures are read.
 */
export function BoxFill({ items, capacity, acceptedToken, actions }: BoxFillProps) {
  const { t } = useTranslation();
  const usable = capacity > 0 ? capacity : null;
  const fill = usable === null ? 0 : Math.min(items, usable);
  const cells = usable === null ? [] : buildBoxCells(fill, usable);
  const grouped = usable !== null && usable > 100;
  const large = usable !== null && usable <= 10;
  const rows = Math.max(1, Math.ceil(cells.length / 10));
  const text =
    items === 0
      ? t("floor.work.boxEmpty")
      : t("floor.work.boxItems", {
          quantity: formatQuantity(items),
          capacity: formatQuantity(capacity),
        });
  return (
    <section
      className="work-instrument work-box-fill"
      aria-labelledby="work-box-fill-title"
      data-grouped={grouped}
    >
      <div className="work-box-fill__head">
        <h2 id="work-box-fill-title">{t("floor.work.box")}</h2>
        {items === 0 ? (
          <strong className="work-box-fill__count" data-empty="true">
            {text}
          </strong>
        ) : (
          <OfCount
            className="work-box-fill__count"
            quantity={items}
            capacity={capacity}
            unit={null}
          />
        )}
      </div>
      {usable !== null && (
        <div
          className="work-box-fill__grid"
          data-dense={cells.length > 20}
          data-grouped={grouped}
          data-large={large ? "true" : undefined}
          style={{
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            ...(large ? { gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` } : {}),
          }}
          role="progressbar"
          aria-label={t("floor.work.box")}
          aria-valuemin={0}
          aria-valuemax={usable}
          aria-valuenow={fill}
          aria-valuetext={text}
        >
          {cells.map((cell) => {
            const latest = acceptedToken > 0 && fill > 0 && fill >= cell.from && fill <= cell.to;
            return (
              <span
                key={`${cell.from}:${latest ? acceptedToken : "stable"}`}
                className="work-box-fill__cell"
                data-state={cell.state}
                data-latest={latest ? "true" : undefined}
                aria-hidden="true"
              >
                {large ? cell.from : null}
              </span>
            );
          })}
        </div>
      )}
      {grouped && <p className="work-box-fill__grouped">{t("floor.work.layout.grouped")}</p>}
      <div className="work-box-fill__actions">{actions}</div>
    </section>
  );
}

/** The tone of the last scan's verdict: accepted, refused, not taken, or none yet. */
export type LastTone = "ok" | "error" | "warn" | "neutral";

export interface LastScanProps {
  text: string;
  tone: LastTone;
  /** Lit for a moment after an accepted code. */
  cued: boolean;
  lineRef: Ref<HTMLParagraphElement>;
}

/**
 * The last scan's verdict in words, on its tone (the cloud's
 * `ScanResultInstrument`). The line is the screen's place for the focus after
 * a message is answered, and is never announced per scan: the tone and the
 * flash say it.
 */
export function LastScan({ text, tone, cued, lineRef }: LastScanProps) {
  const { t } = useTranslation();
  return (
    <section className="work-instrument work-scan-result" aria-labelledby="work-last-title">
      <h2 id="work-last-title">{t("floor.work.layout.last")}</h2>
      <p
        className={cued ? "work-screen__last work-screen__last--cue" : "work-screen__last"}
        data-verdict={tone}
        ref={lineRef}
        tabIndex={-1}
      >
        {text}
      </p>
    </section>
  );
}

export interface WorkFactsProps {
  facts: readonly { term: string; value: string }[];
}

/** The shift's figures beside the box (the cloud's journal column, in its row style). */
export function WorkFacts({ facts }: WorkFactsProps) {
  const { t } = useTranslation();
  return (
    <section className="work-instrument work-facts" aria-labelledby="work-facts-title">
      <h2 id="work-facts-title">{t("floor.work.layout.summary")}</h2>
      <dl>
        {facts.map((fact) => (
          <div key={fact.term}>
            <dt>{fact.term}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The width of a footer action, as the cloud gives it. */
export const FOOTER_ACTION_STYLE: CSSProperties = { width: "220px", maxWidth: "100%" };

/** A floor button of the footer, its width merged with any style the caller gives. */
export function FooterAction({ style, ...props }: ButtonProps) {
  return (
    <Button
      size="floor"
      className="work-footer__action"
      {...props}
      style={{ ...FOOTER_ACTION_STYLE, ...style }}
    />
  );
}
