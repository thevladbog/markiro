import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert } from "@markiro/ui";

import { AuthLayout } from "./AuthLayout.js";

/** Public self-registration is disabled: cabinet accounts are provisioned from tenant invitations. */
export function RegisterPage() {
  const { t } = useTranslation();

  return (
    <AuthLayout title={t("auth.register.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Alert tone="info" title={t("auth.register.inviteOnlyTitle")}>
          {t("auth.register.inviteOnlyBody")}
        </Alert>
        <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
          {t("auth.register.haveAccount")} <Link to="/login">{t("auth.register.loginLink")}</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
