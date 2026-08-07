import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import type { DeviceType } from "./api.js";

export interface PairingInstructionsProps {
  code: string;
  deviceName: string;
  deviceType: DeviceType;
  placeName: string | null;
  organizationName: string | null;
  issuedAt: string;
  expiresAt: string;
  barcode: ReactNode;
}

function groupDigits(code: string): string {
  return code.replace(/(\d{4})(\d{4})/, "$1 $2");
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
}

/** The isolated document rendered by the browser's native print dialog. */
export function PairingInstructions({
  code,
  deviceName,
  deviceType,
  placeName,
  organizationName,
  issuedAt,
  expiresAt,
  barcode,
}: PairingInstructionsProps) {
  const { t } = useTranslation();
  return (
    <section className="mk-pairing-print" aria-label={t("pages.devices.pairing.printTitle")}>
      <h1>{t("pages.devices.pairing.printTitle")}</h1>
      <dl>
        <div>
          <dt>{t("pages.devices.pairing.organization")}</dt>
          <dd>{organizationName ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("pages.devices.pairing.deviceType")}</dt>
          <dd>{t(`pages.devices.type.${deviceType}`)}</dd>
        </div>
        <div>
          <dt>{t("pages.devices.pairing.deviceName")}</dt>
          <dd>{deviceName}</dd>
        </div>
        <div>
          <dt>{t("pages.devices.pairing.place")}</dt>
          <dd>{placeName ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("pages.devices.pairing.issuedAt")}</dt>
          <dd>{dateTime(issuedAt)}</dd>
        </div>
        <div>
          <dt>{t("pages.devices.pairing.expiresAt")}</dt>
          <dd>{dateTime(expiresAt)}</dd>
        </div>
      </dl>
      <p className="mk-pairing-print__digits">{groupDigits(code)}</p>
      <p className="mk-pairing-print__raw">{t("pages.devices.pairing.rawDigits", { code })}</p>
      <div className="mk-pairing-print__barcode">{barcode}</div>
      <ol>
        <li>{t("pages.devices.pairing.instructions.one")}</li>
        <li>{t("pages.devices.pairing.instructions.two")}</li>
        <li>{t("pages.devices.pairing.instructions.three")}</li>
      </ol>
    </section>
  );
}
