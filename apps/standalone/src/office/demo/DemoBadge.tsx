import { useTranslation } from "react-i18next";

import { Badge } from "@markiro/ui";

/** «Демо»: a category tag, no phase (spec 2026-10-21), on the demo product and its shifts. */
export function DemoBadge() {
  const { t } = useTranslation();
  return <Badge tone="magenta">{t("office.demo.badge")}</Badge>;
}
