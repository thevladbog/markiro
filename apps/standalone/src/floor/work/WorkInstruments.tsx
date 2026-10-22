import { useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Button, type ButtonProps } from "@markiro/ui";

import type { LocalExecutor } from "../../local/executor.js";
import { productMonogram } from "../shifts/product-accent.js";
import { usePhotoBacking } from "../shifts/photo-backing.js";
import { ProductPhotoImage, useStoredProductPhoto } from "../shifts/ProductPhoto.js";
import { formatClock, formatQuantity } from "../shifts/shift-text.js";
import { cellSerialPlan, serialForCell, type CellSerialPlan } from "./box-cells.js";
import { ScanCode } from "./ScanCode.js";

/*
 * The presentation of the work screen, ported from the cloud station's
 * `ui/work` (ShiftBand, BoxFillInstrument, ScanResultInstrument, WorkFooter;
 * apps/station/src/ui/work). Only the look is ported: what the cloud reads
 * there (a photo, the shift's total across terminals, the journal) the
 * standalone does not have, and the figures come from the work screen.
 */

/** A database that holds nothing: the band without one reads no photo. */
const NO_LOCAL: LocalExecutor = {
  query: () => Promise.resolve([]),
  transaction: () => Promise.resolve([]),
};

const PERCENT = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 0 });

export interface ShiftBandProps {
  productName: string;
  gtin: string;
  number: string;
  counterpartyName: string | null;
  /** Codes this station holds in the shift: its actual quantity. The one place the count is shown. */
  accepted: number;
  plannedQty: number | null;
  /** The shift's way of working, as its chip says it («Проверка с дубликатом»). */
  modeLabel: string;
  /** A validation shift's refused scans by kind: the small counters beside the accepted one. */
  refused?: { duplicates: number; errors: number };
  /** The station's database and the product's id: its photo (beta 3.2). */
  local?: LocalExecutor;
  productId?: string;
  /**
   * A shift several devices work (plan 2b): this station's own count (`mine`), the whole shift's
   * (`total`: the others' part by the host and `mine`), the host's time of its part (`asOf`), and
   * whether the link is down, when that time is said («данные от ЧЧ:ММ»).
   */
  shared?: { mine: number; total: number; asOf: string; stale: boolean };
}

/**
 * What the shift makes and how much of it is made, on the kit's one gradient card: the product's
 * photo whole in a rounded frame, its name and chips (the shift's number, the GTIN, the mode),
 * and the single counter «Принято в смене» — the only place the accepted count stands — with the
 * small «Дубли» and «Ошибки» of a validation shift beside it. A shift several devices work
 * (plan 2b) shows the whole shift's count in the large counter («Всего в смене», the plan by it)
 * and this station's own in a small one beside it («Моя станция»), the group named «Моя станция:
 * N · Всего в смене: K из M»; the time of the host's figures is said under the total while the
 * link is down.
 */
export function ShiftBand({
  productName,
  gtin,
  number,
  counterpartyName,
  accepted,
  plannedQty,
  modeLabel,
  refused,
  local,
  productId,
  shared,
}: ShiftBandProps) {
  const { t } = useTranslation();
  // The photo the station holds; without a database (a test of the band alone) the monogram.
  const photo = useStoredProductPhoto(local ?? NO_LOCAL, productId ?? "");
  const backing = usePhotoBacking(local === undefined ? null : photo);
  // A shared shift counts and plans by the whole shift (plan 2b); a solo one by its own codes.
  const counted = shared === undefined ? accepted : shared.total;
  const ratio = plannedQty === null || plannedQty <= 0 ? null : Math.min(1, counted / plannedQty);
  const totalLabel = t(shared === undefined ? "floor.work.accepted" : "floor.work.shared.total");
  const summary =
    shared === undefined
      ? null
      : plannedQty === null
        ? t("floor.work.shared.summaryNoPlan", {
            mine: formatQuantity(shared.mine),
            total: formatQuantity(shared.total),
          })
        : t("floor.work.shared.summary", {
            mine: formatQuantity(shared.mine),
            total: formatQuantity(shared.total),
            planned: formatQuantity(plannedQty),
          });
  return (
    <section
      className="work-shift-band"
      aria-label={t("floor.work.product", { name: productName, gtin })}
    >
      <div className="work-shift-band__photo" data-photo-backing={backing}>
        <ProductPhotoImage
          photo={local === undefined ? null : photo}
          fallback={
            <span aria-hidden="true" className="work-shift-band__monogram">
              {productMonogram(productName)}
            </span>
          }
        />
      </div>
      <div className="work-shift-band__copy">
        <h2 title={productName}>{productName}</h2>
        <div className="work-shift-band__chips">
          <span className="work-shift-band__chip">{t("floor.work.title", { number })}</span>
          <span className="work-shift-band__chip work-shift-band__chip--mono">{`GTIN ${gtin}`}</span>
          <span className="work-shift-band__chip">{modeLabel}</span>
          {counterpartyName !== null && (
            <span className="work-shift-band__chip" title={counterpartyName}>
              {t("floor.work.layout.counterparty", { name: counterpartyName })}
            </span>
          )}
        </div>
      </div>
      <div
        className="work-shift-band__counters"
        {...(summary === null ? {} : { role: "group", "aria-label": summary })}
      >
        <div className="work-shift-band__total">
          <p className="work-shift-band__label">{totalLabel}</p>
          <p className="work-shift-band__count">{formatQuantity(counted)}</p>
          {plannedQty !== null && ratio !== null && (
            <>
              <p className="work-shift-band__planned">{`/ ${formatQuantity(plannedQty)}`}</p>
              <div
                className="work-shift-band__bar"
                role="progressbar"
                aria-label={totalLabel}
                aria-valuemin={0}
                aria-valuemax={plannedQty}
                aria-valuenow={Math.min(counted, plannedQty)}
                aria-valuetext={`${formatQuantity(counted)} / ${formatQuantity(plannedQty)}`}
              >
                <span style={{ width: `${Math.round(ratio * 1000) / 10}%` }} />
              </div>
              <p className="work-shift-band__meta">
                {t("floor.work.layout.planPercent", {
                  percent: PERCENT.format(counted / plannedQty),
                })}
              </p>
            </>
          )}
          {shared?.stale === true && (
            <p className="work-shift-band__stale">
              {t("floor.work.shared.asOf", { time: formatClock(shared.asOf) })}
            </p>
          )}
        </div>
        {shared !== undefined && (
          <div className="work-shift-band__small work-shift-band__small--mine">
            <p className="work-shift-band__label">{t("floor.work.shared.mine")}</p>
            <p className="work-shift-band__small-count">{formatQuantity(shared.mine)}</p>
          </div>
        )}
        {refused !== undefined && (
          <>
            <div className="work-shift-band__small">
              <p className="work-shift-band__label">{t("floor.validation.duplicates")}</p>
              <p className="work-shift-band__small-count">{formatQuantity(refused.duplicates)}</p>
            </div>
            <div className="work-shift-band__small">
              <p className="work-shift-band__label">{t("floor.validation.errors")}</p>
              <p className="work-shift-band__small-count">{formatQuantity(refused.errors)}</p>
            </div>
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
  /** The serials (AI 21) of the codes in the box, in the order of their places (1, 2, 3...). */
  serials?: readonly string[];
}

/**
 * Whether the cells have room for their serial: the grid's content box is measured (and again
 * on every resize) and `cellSerialPlan` decides from it; before a layout exists the answer is no.
 */
function useCellSerialPlan(
  gridRef: RefObject<HTMLDivElement | null>,
  columns: number,
  rows: number,
  numbered: boolean,
  serialLength: number,
): CellSerialPlan {
  const [plan, setPlan] = useState<CellSerialPlan>({ show: false });
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) return undefined;
    const measure = () => {
      const style = getComputedStyle(grid);
      const next = cellSerialPlan({
        width: grid.clientWidth,
        height: grid.clientHeight,
        columns,
        rows,
        gap: parseFloat(style.columnGap) || 0,
        serialLength,
        numbered,
      });
      setPlan((current) =>
        current.show === next.show &&
        (!current.show ||
          !next.show ||
          (current.fontPx === next.fontPx && current.chars === next.chars))
          ? current
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [gridRef, columns, rows, numbered, serialLength]);
  return plan;
}

/**
 * The open box as cells (the cloud's `BoxFillInstrument`): its title and
 * count in one row, a cell a place, the next place outlined, and its action
 * under them. The term and its value stay one after the other («Открытый
 * короб» · «2 из 12»), as the floor's figures are read.
 */
export function BoxFill({ items, capacity, acceptedToken, actions, serials = [] }: BoxFillProps) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLDivElement>(null);
  const usable = capacity > 0 ? capacity : null;
  const fill = usable === null ? 0 : Math.min(items, usable);
  const cells = usable === null ? [] : buildBoxCells(fill, usable);
  const grouped = usable !== null && usable > 100;
  const large = usable !== null && usable <= 10;
  const rows = Math.max(1, Math.ceil(cells.length / 10));
  const serialLength = serials.reduce((longest, serial) => Math.max(longest, serial.length), 0);
  const serialPlan = useCellSerialPlan(
    gridRef,
    large ? cells.length : 10,
    large ? 1 : rows,
    large,
    serialLength,
  );
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
          ref={gridRef}
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
            const serial =
              serialPlan.show && cell.state === "filled" ? serials[cell.from - 1] : undefined;
            return (
              <span
                key={`${cell.from}:${latest ? acceptedToken : "stable"}`}
                className="work-box-fill__cell"
                data-state={cell.state}
                data-latest={latest ? "true" : undefined}
                aria-hidden="true"
              >
                {large ? <span className="work-box-fill__number">{cell.from}</span> : null}
                {serial !== undefined && serialPlan.show && (
                  <span
                    className="work-box-fill__serial"
                    style={{ fontSize: `${serialPlan.fontPx}px` }}
                    data-serial-cell=""
                  >
                    {serialForCell(serial, serialPlan.chars)}
                  </span>
                )}
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
export type LastTone = "ok" | "duplicate" | "error" | "warn" | "neutral";

export interface LastScanProps {
  /** The status word of the verdict («Принят», «Дубль», «Ошибка»), shown large. */
  word: string;
  /** The verdict in words beyond the status word; empty when the word says it all. */
  text: string;
  tone: LastTone;
  /** The scanned code as the history lists it (the serial first, the GTIN short), when known. */
  code: { gtin14: string | null; serial: string | null; fallback: string } | null;
  /** The scan's time, on this computer's clock; `null` while there is no scan. */
  time: string | null;
  /** Lit for a moment after an accepted code. */
  cued: boolean;
  lineRef: Ref<HTMLDivElement>;
}

/** The hero's glyph: a check in a ring, a copy, a cross, a pause, or nothing yet. */
function VerdictIcon({ tone }: { tone: LastTone }) {
  const common = {
    width: 56,
    height: 56,
    viewBox: "0 0 56 56",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "work-scan-hero__icon",
  };
  if (tone === "ok") {
    return (
      <svg {...common}>
        <circle cx="28" cy="28" r="24" />
        <path d="m17 29 8 8 15-17" />
      </svg>
    );
  }
  if (tone === "error") {
    return (
      <svg {...common}>
        <circle cx="28" cy="28" r="24" />
        <path d="m19 19 18 18M37 19 19 37" />
      </svg>
    );
  }
  if (tone === "duplicate") {
    return (
      <svg {...common}>
        <circle cx="28" cy="28" r="24" />
        <rect x="18" y="22" width="14" height="14" rx="3" />
        <path d="M24 18h10a4 4 0 0 1 4 4v10" />
      </svg>
    );
  }
  if (tone === "warn") {
    return (
      <svg {...common}>
        <circle cx="28" cy="28" r="24" />
        <path d="M28 16v16M28 39v1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="28" cy="28" r="24" strokeDasharray="4 7" />
    </svg>
  );
}

/**
 * «Последний скан»: the verdict as one large status word with its glyph on the verdict's tone,
 * the code's tail in the counter's face and the time, and a line of words only where the word
 * leaves something to say (why a duplicate is one). It never repeats the shift's count: that
 * stands in the band alone. The element with the verdict is the screen's place for the focus
 * after a message is answered, and is never announced per scan: the tone and the flash say it.
 */
export function LastScan({ word, text, tone, code, time, cued, lineRef }: LastScanProps) {
  const { t } = useTranslation();
  return (
    <section className="work-instrument work-scan-result" aria-labelledby="work-last-title">
      <div className="work-scan-result__head">
        <h2 id="work-last-title">{t("floor.work.layout.last")}</h2>
        {time !== null && <time className="work-scan-result__time">{time}</time>}
      </div>
      <div
        className={cued ? "work-screen__last work-screen__last--cue" : "work-screen__last"}
        data-verdict={tone}
        ref={lineRef}
        tabIndex={-1}
      >
        <p className="work-scan-hero__word">
          <VerdictIcon tone={tone} />
          <span>{word}</span>
        </p>
        {code !== null && (
          <p className="work-scan-hero__code">
            <ScanCode gtin14={code.gtin14} serial={code.serial} fallback={code.fallback} />
          </p>
        )}
        {text !== "" && <p className="work-scan-hero__detail">{text}</p>}
      </div>
    </section>
  );
}

export interface WorkFactsProps {
  facts: readonly { term: string; value: string }[];
}

/** The shift's figures of an aggregation shift (closed boxes, the last SSCC), in their row style. */
export function WorkFacts({ facts }: WorkFactsProps) {
  const { t } = useTranslation();
  if (facts.length === 0) return null;
  return (
    <section className="work-instrument work-facts" aria-labelledby="work-facts-title">
      <h2 id="work-facts-title" className="work-sr">
        {t("floor.work.layout.summary")}
      </h2>
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

/**
 * A floor button of the footer: the kit's 84 px action, filling its third of the row (the
 * footer's grid gives it the width).
 */
export function FooterAction({ className, ...props }: ButtonProps) {
  return (
    <Button
      size="floor"
      className={`work-footer__action floor-primary${className === undefined ? "" : ` ${className}`}`}
      {...props}
    />
  );
}
