import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { EmptyState } from "@markiro/ui";

/** Route-level denial screen, ready for capability-gated routes. */
export function ForbiddenPage() {
  const { t } = useTranslation();

  return (
    <div data-testid="forbidden-page" style={{ padding: "48px 32px" }}>
      <EmptyState
        title={t("access.forbiddenTitle")}
        hint={t("access.forbiddenBody")}
        action={<Link to="/">{t("access.backToOverview")}</Link>}
      />
    </div>
  );
}
