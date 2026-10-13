import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { formatQuantity } from "../shifts/shift-text.js";
import { OfCount } from "../work/WorkInstruments.js";
import "./pallet-strip.css";

const PERCENT = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 0 });

export interface PalletStripProps {
  /** The open pallet's boxes not taken apart; past the capacity while no pallet serial is left. */
  boxCount: number;
  capacity: number;
  /** «Закрыть паллету досрочно» waits: a stop stands, or the floor is leaving. */
  closeDisabled: boolean;
  onClose: () => void;
  /**
   * The full pallet waits for its close (no pallet serial, or one that did not
   * fit): said under the strip, as the cloud's «нет серий для паллеты» is, so
   * that it never covers the box the operator goes on filling.
   */
  warning?: { title: string; body: string } | null;
}

/**
 * The open pallet in one row under the box (the cloud's `PalletStrip`,
 * apps/station/src/components/PalletStrip.tsx): «Паллета 15 из 66 коробов ·
 * 23 %», its bar, what is left, and the early close beside it. The term and
 * its value stay one after the other, as the floor's figures are read. The
 * cloud's «Состав паллеты» has no counterpart here yet.
 */
export function PalletStrip({
  boxCount,
  capacity,
  closeDisabled,
  onClose,
  warning = null,
}: PalletStripProps) {
  const { t } = useTranslation();
  const previous = useRef(boxCount);
  const [highlight, setHighlight] = useState(0);
  useEffect(() => {
    if (boxCount > previous.current) setHighlight((value) => value + 1);
    previous.current = boxCount;
  }, [boxCount]);
  const ratio = capacity > 0 ? boxCount / capacity : 0;
  const left = Math.max(0, capacity - boxCount);
  return (
    <section className="work-instrument pallet-strip" aria-label={t("floor.work.pallet")}>
      <div className="pallet-strip__summary">
        <dl className="pallet-strip__readout">
          <dt>{t("floor.work.pallet")}</dt>
          <dd key={highlight} data-highlight={highlight > 0 ? "true" : undefined}>
            <OfCount
              className="pallet-strip__count"
              quantity={boxCount}
              capacity={capacity}
              unit={t("floor.work.layout.boxesUnit")}
            />
          </dd>
          <dd
            className="pallet-strip__percent"
            aria-hidden="true"
          >{`· ${PERCENT.format(ratio)}`}</dd>
        </dl>
        <div
          className="pallet-strip__bar"
          role="progressbar"
          aria-label={t("floor.work.pallet")}
          aria-valuemin={0}
          aria-valuemax={capacity}
          aria-valuenow={Math.min(boxCount, capacity)}
          aria-valuetext={t("floor.work.palletBoxes", {
            quantity: formatQuantity(boxCount),
            capacity: formatQuantity(capacity),
          })}
        >
          <span style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
        </div>
        <p className="pallet-strip__meta">{t("floor.work.layout.palletLeft", { count: left })}</p>
      </div>
      <div className="pallet-strip__actions">
        <Button
          size="floor"
          variant="secondary"
          data-action="close-pallet"
          disabled={closeDisabled}
          onClick={onClose}
        >
          {t("floor.work.closePalletEarly")}
        </Button>
      </div>
      {/* On the page before it is said, so that it is heard when it comes. */}
      <p className="pallet-strip__warning" role="status">
        {warning !== null && (
          <>
            <strong>{warning.title}</strong> {warning.body}
          </>
        )}
      </p>
    </section>
  );
}
