import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Button, EmptyState } from "@markiro/ui";

import { useAuthClient } from "../auth/client.js";
import { useClearAuthQueryCache } from "../query/AuthQueryBoundary.js";

/** Intentional, non-operational state for organizations without cabinet access. */
export function NoCabinetAccess() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const clearAuthQueryCache = useClearAuthQueryCache();

  const handleSelectOrganization = () => {
    clearAuthQueryCache();
    void navigate("/org/select");
  };

  const handleSignOut = async () => {
    clearAuthQueryCache();
    try {
      await authClient.signOut();
    } finally {
      void navigate("/login", { replace: true });
    }
  };

  return (
    <div style={{ padding: "48px 32px" }}>
      <EmptyState
        title={t("access.noAccessTitle")}
        hint={t("access.noAccessBody")}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" onClick={handleSelectOrganization}>
              {t("access.selectOrganization")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => void handleSignOut()}>
              {t("common.signOut")}
            </Button>
          </div>
        }
      />
    </div>
  );
}
