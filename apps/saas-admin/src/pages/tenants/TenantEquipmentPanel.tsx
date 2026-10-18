import { useTranslation } from "react-i18next";

import { IS_PLATFORM_ONLY } from "../../server-profile.js";
import { ServerProfileNotice } from "../../components/ServerProfileNotice.js";
import { DeviceLicensingPanel } from "./DeviceLicensingPanel.js";
import { StandaloneSitesPanel } from "./StandaloneSitesPanel.js";

export function TenantEquipmentPanel({
  tenantId,
  canWrite,
  canManageStandalone,
}: {
  tenantId: string;
  canWrite: boolean;
  canManageStandalone: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className="tenant-equipment-workspace" aria-labelledby="tenant-equipment-title">
      <header className="tenant-equipment-workspace__header">
        <p>{t("tenants.detail.equipment.eyebrow")}</p>
        <h2 id="tenant-equipment-title">{t("tenants.detail.equipment.title")}</h2>
        <span>{t("tenants.detail.equipment.description")}</span>
      </header>
      {IS_PLATFORM_ONLY ? (
        <ServerProfileNotice kind="devices" />
      ) : (
        <DeviceLicensingPanel tenantId={tenantId} canWrite={canWrite} />
      )}
      {canManageStandalone ? <StandaloneSitesPanel tenantId={tenantId} /> : null}
    </section>
  );
}
