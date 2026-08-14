import { useTranslation } from "react-i18next";
import type { KioskCartLine } from "../session/cart.js";

export interface ItemKindIconProps {
  kind: KioskCartLine["kind"];
}

export function ItemKindIcon({ kind }: ItemKindIconProps): React.JSX.Element {
  const { t } = useTranslation();
  const label = t(kind === "km" ? "cart.kindDataMatrix" : "cart.kindBox");

  return (
    <span className="kiosk-kind-icon" role="img" aria-label={label}>
      {kind === "km" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM18 14h3v3h-3zM14 18h3v3h-3z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m3.5 7 8.5-4 8.5 4v10L12 21l-8.5-4V7Z" />
          <path d="m3.5 7 8.5 4 8.5-4M12 11v10M8 5l8.5 4" />
        </svg>
      )}
    </span>
  );
}
