import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import type { HostUpdateOffer } from "../update/host-offer.js";

/**
 * The station's line about an update (spec §10.11.5): words only, never a
 * control, and never during a shift's work — an update never interrupts a
 * shift. An administrator installs it from the office on this PC; a station
 * the host refuses already gets the button on the sign-in screen
 * (`FloorUpdatePanel`). It lives inside the status bar's polite region, so it
 * loses the alert's own role.
 */
export function FloorUpdateLine({
  offer,
  appTooOld,
  inShift,
}: {
  offer: HostUpdateOffer;
  appTooOld: boolean;
  inShift: boolean;
}) {
  const { t } = useTranslation();
  if (inShift) return null;
  if (offer.kind === "available") {
    return (
      <Alert tone="info" role="presentation">
        {offer.required
          ? t("floor.update.required", { host: offer.hostVersion })
          : t("floor.update.available")}
      </Alert>
    );
  }
  if (appTooOld) {
    return (
      <Alert tone="warn" role="presentation">
        {t("floor.update.requiredNoPackage")}
      </Alert>
    );
  }
  return null;
}
