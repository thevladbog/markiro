import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";

import { Button, Card, Spinner } from "@markiro/ui";

import { useAuthClient } from "../auth/client.js";

/**
 * Guarded root route: redirects to /login (no session) or /org/select
 * (session without an active organization); otherwise renders a placeholder
 * for the real app shell, which lands in plan-03 task 10.
 */
export function ShellPage() {
  const { t } = useTranslation();
  const authClient = useAuthClient();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 96 }}>
        <Spinner />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!session.session.activeOrganizationId) {
    return <Navigate to="/org/select" replace />;
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 96 }}>
      <Card title={t("common.appName")} style={{ width: 420 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
            {t("shell.welcome", { email: session.user.email })}
          </p>
          <p style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
            {t("shell.activeOrg", { organizationId: session.session.activeOrganizationId })}
          </p>
          <Button variant="secondary" onClick={() => void authClient.signOut()}>
            {t("common.signOut")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
