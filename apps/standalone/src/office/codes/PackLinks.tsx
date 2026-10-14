import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { StatusChip, type TagPhase } from "@markiro/ui";

import { ssccText, type PackState } from "../shifts/shift-card.js";

/** A box's or a pallet's state in its phase: the cloud tags one taken apart `dismantled`. */
export const PACK_PHASE = {
  open: "active",
  closed: "done",
  disassembled: "dismantled",
} as const satisfies Record<PackState, TagPhase>;

interface PackLinkProps {
  id: string;
  sscc: string | null;
}

function PackLink({ to, sscc }: { to: string; sscc: string | null }) {
  const { t } = useTranslation();
  // A row of a table opens its own card on a click: the link does not also open it.
  return (
    <Link to={to} onClick={(event) => event.stopPropagation()}>
      {sscc === null ? t("office.packs.noSscc") : ssccText(sscc)}
    </Link>
  );
}

/** A box as its SSCC, a link to the box's card (plan КРТ). */
export function BoxLink({ id, sscc }: PackLinkProps) {
  return <PackLink to={`/codes/box/${id}`} sscc={sscc} />;
}

/** A pallet as its SSCC, a link to the pallet's card (plan КРТ). */
export function PalletLink({ id, sscc }: PackLinkProps) {
  return <PackLink to={`/codes/pallet/${id}`} sscc={sscc} />;
}

/** Any words that name a box or a pallet, as a link to its card (the code card's own wording). */
export function PackTextLink({
  kind,
  id,
  children,
}: {
  kind: "box" | "pallet";
  id: string;
  children: string;
}) {
  return (
    <Link to={`/codes/${kind}/${id}`} onClick={(event) => event.stopPropagation()}>
      {children}
    </Link>
  );
}

/** A pallet whose SSCC is not known yet is still a pallet: «Открытая». */
export function PalletLinkOrOpen({ id, sscc }: PackLinkProps) {
  const { t } = useTranslation();
  return sscc === null ? (
    <Link to={`/codes/pallet/${id}`} onClick={(event) => event.stopPropagation()}>
      {t("office.packs.openPallet")}
    </Link>
  ) : (
    <PalletLink id={id} sscc={sscc} />
  );
}

/** A state in a chip, in words (`office.shiftCard.boxState`, `palletState`). */
export function PackStateChip({ state, kind }: { state: PackState; kind: "box" | "pallet" }) {
  const { t } = useTranslation();
  return (
    <StatusChip phase={PACK_PHASE[state]} label={t(`office.shiftCard.${kind}State.${state}`)} />
  );
}
