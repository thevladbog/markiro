import { useTranslation } from "react-i18next";

import { StatusChip } from "@markiro/ui";

import { palletCountState } from "./shift-card.js";

/**
 * The tag a closed pallet carries when the boxes its station counted at the
 * close are not the host's count now (plan КРТ-4). It says why in plain
 * words, as a tooltip and as the tag's description, because the same two
 * numbers mean two different things:
 *
 * - the difference is exactly the pallet's boxes taken apart since the close:
 *   a neutral «Состав изменён расформированием» (the composition changed
 *   legitimately; the office shows it correctly), not a warning;
 * - otherwise a warning, whose explanation says there is no disassembly (or
 *   not enough of it) to account for the difference, so it is a real one.
 *
 * Nothing is shown while the counts agree.
 *
 * `differsLabel` is the warning's own wording, which each surface keeps
 * («Счёт коробов станции другой» on the shift's card, «Состав изменился после
 * закрытия» in the lists).
 */
export function PalletCountTag({
  pallet,
  differsLabel,
}: {
  pallet: Parameters<typeof palletCountState>[0];
  differsLabel: string;
}) {
  const { t } = useTranslation();
  const state = palletCountState(pallet);
  if (state === "same" || pallet.boxCountReported === null) return null;
  const figures = {
    reported: pallet.boxCountReported,
    boxes: pallet.boxes,
    disassembled: pallet.disassembledBoxes,
  };
  const hint = t(
    state === "explained"
      ? "office.palletCount.explainedHint"
      : pallet.disassembledBoxes > 0
        ? "office.palletCount.partialHint"
        : "office.palletCount.realHint",
    figures,
  );
  return (
    <StatusChip
      phase={state === "explained" ? "none" : "attention"}
      wrap
      label={state === "explained" ? t("office.palletCount.explainedLabel") : differsLabel}
      // The tooltip for the mouse, the description for a screen reader (the label stays the tag's
      // own words, so the row reads the same without it).
      title={hint}
      aria-description={hint}
    />
  );
}
