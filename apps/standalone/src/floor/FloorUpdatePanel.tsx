import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import type { HostUpdateOffer } from "../update/host-offer.js";

/**
 * «Обновить с хоста» on the sign-in screen of a station the host refuses
 * already (`app_too_old`, ЛО16): no office opens for it, so the button is
 * here; Windows asks for an administrator (UAC) before anything is
 * installed. Nobody is signed in, so no shift's work is interrupted.
 */
export function FloorUpdatePanel({
  offer,
  onUpdate,
}: {
  offer: Extract<HostUpdateOffer, { kind: "available" }>;
  onUpdate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card className="floor-update">
      <p>{t("floor.update.panel", { host: offer.hostVersion, version: offer.manifest.version })}</p>
      <Button size="floor" onClick={onUpdate}>
        {t("floor.update.fromHost")}
      </Button>
    </Card>
  );
}
