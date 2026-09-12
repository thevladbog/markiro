import { useTranslation } from "react-i18next";

export type PalletSerialsState = "available" | "empty";

export interface PalletStripProps {
  /** The current open pallet's live box count -- can exceed `capacity` when
   * this device's serial pool is dry (see `serials` below). */
  boxCount: number;
  /** The shift's `palletBoxCapacity`. */
  capacity: number;
  /**
   * "empty" when this device could not close the pallet because its local
   * SSCC pool has no pallet-range serial left. `close-box.ts` leaves the
   * pallet open and over capacity in that case rather than blocking further
   * boxes -- boxes and scanning continue unaffected -- so this strip is the
   * ONLY place that fact surfaces. Per the project's accessibility rule,
   * status is never colour-only: the warning is always spelled out in text.
   */
  serials: PalletSerialsState;
}

/**
 * A compact, always-visible readout of the shift's current pallet: how many
 * boxes are on it against capacity, and -- in text, not colour -- whether
 * this device can currently close it at all. Rendered only while the shift
 * has pallets on (`WorkScreen`'s `palletBoxCapacity !== null`); this
 * component itself does not know or care why.
 */
export function PalletStrip({ boxCount, capacity, serials }: PalletStripProps) {
  const { t } = useTranslation();
  return (
    <section
      className="work-instrument pallet-strip"
      aria-label={t("pallet.title")}
      data-serials={serials}
    >
      <p className="pallet-strip__progress">
        {t("pallet.progress", { boxes: boxCount, capacity })}
      </p>
      {serials === "empty" ? (
        <p className="pallet-strip__warning" role="status">
          {t("pallet.noSerials")}
        </p>
      ) : null}
    </section>
  );
}
