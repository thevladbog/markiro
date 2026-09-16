import { useTranslation } from "react-i18next";

import { DeviceLicensingPanel } from "./DeviceLicensingPanel.js";

export function TenantEquipmentPanel({
  tenantId,
  canWrite,
}: {
  tenantId: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className="tenant-equipment-workspace" aria-labelledby="tenant-equipment-title">
      <header className="tenant-equipment-workspace__header">
        <p>{t("tenants.detail.equipment.eyebrow")}</p>
        <h2 id="tenant-equipment-title">{t("tenants.detail.equipment.title")}</h2>
        <span>{t("tenants.detail.equipment.description")}</span>
      </header>
      <DeviceLicensingPanel tenantId={tenantId} canWrite={canWrite} />
    </section>
  );
}
