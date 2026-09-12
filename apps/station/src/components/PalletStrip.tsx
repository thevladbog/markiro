import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";

export type PalletSerialsState = "available" | "empty";

export interface PalletStripProps {
  /** The live count may exceed capacity when the local pallet SSCC pool is empty. */
  boxCount: number;
  capacity: number;
  serials: PalletSerialsState;
  lastBoxSscc?: string | null;
  disabled?: boolean;
  onShowContents?: () => void;
  onClose?: () => void;
}

export function PalletStrip({
  boxCount,
  capacity,
  serials,
  lastBoxSscc,
  disabled = false,
  onShowContents,
  onClose,
}: PalletStripProps) {
  const { t, i18n } = useTranslation();
  const previousCount = useRef(boxCount);
  const [highlight, setHighlight] = useState(0);
  useEffect(() => {
    if (boxCount > previousCount.current) setHighlight((value) => value + 1);
    previousCount.current = boxCount;
  }, [boxCount]);
  const ratio = capacity > 0 ? boxCount / capacity : 0;
  const percent = new Intl.NumberFormat(i18n.language, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(ratio);
  return (
    <section
      className="work-instrument pallet-strip"
      aria-label={t("pallet.title")}
      data-serials={serials}
    >
      <div className="pallet-strip__summary">
        <h2>{t("pallet.current")}</h2>
        <div className="pallet-strip__readout">
          <strong
            key={highlight}
            data-highlight={highlight > 0 ? "true" : undefined}
            className="pallet-strip__progress"
          >
            {t("pallet.progress", { boxes: boxCount, capacity })}
          </strong>
          <span>{percent}</span>
        </div>
        <div
          className="pallet-strip__bar"
          role="progressbar"
          aria-label={t("pallet.current")}
          aria-valuemin={0}
          aria-valuemax={capacity}
          aria-valuenow={Math.min(boxCount, capacity)}
          aria-valuetext={t("pallet.progress", { boxes: boxCount, capacity })}
        >
          <span style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
        </div>
        <p className="pallet-strip__remaining">
          {t("pallet.remaining", { count: Math.max(0, capacity - boxCount) })}
        </p>
        {lastBoxSscc ? (
          <p className="pallet-strip__last">
            {t("pallet.lastBox")} <code>…{lastBoxSscc.slice(-6)}</code>
          </p>
        ) : null}
      </div>
      <div className="pallet-strip__actions">
        {onShowContents ? (
          <Button
            size="floor"
            variant="secondary"
            disabled={disabled || boxCount === 0}
            onClick={onShowContents}
          >
            {t("pallet.contents")}
          </Button>
        ) : null}
        {onClose ? (
          <Button
            size="floor"
            variant="secondary"
            disabled={disabled || boxCount === 0}
            onClick={onClose}
          >
            {t("pallet.closeCurrent")}
          </Button>
        ) : null}
      </div>
      {serials === "empty" ? (
        <p className="pallet-strip__warning" role="status">
          {t("pallet.noSerials")}
        </p>
      ) : null}
    </section>
  );
}
