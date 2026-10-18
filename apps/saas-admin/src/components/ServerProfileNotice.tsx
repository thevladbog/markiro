import { useTranslation } from "react-i18next";
import { Alert } from "@markiro/ui";
import { IS_PLATFORM_ONLY } from "../server-profile.js";

export function ServerProfileNotice({
  kind,
}: {
  kind:
    | "cabinet"
    | "nationalCatalog"
    | "grants"
    | "support"
    | "cloudUsage"
    | "devices"
    | "productionReports";
}) {
  const { t } = useTranslation();
  return IS_PLATFORM_ONLY ? <Alert tone="info">{t(`serverProfile.${kind}`)}</Alert> : null;
}
