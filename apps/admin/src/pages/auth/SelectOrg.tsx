import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { Alert, Button, Spinner } from "@markiro/ui";

import { useAuthClient, type OrganizationSummary } from "../../auth/client.js";
import { AuthLayout } from "./AuthLayout.js";

export function SelectOrgPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();

  const [organizations, setOrganizations] = useState<OrganizationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authClient.organization
      .list()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setLoadError(error?.message ?? t("auth.selectOrg.genericError"));
          return;
        }
        setOrganizations(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t("auth.selectOrg.genericError"));
      });
    return () => {
      cancelled = true;
    };
    // Runs once on mount; the auth client instance is stable for the
    // lifetime of the app (or the test that injects a fake one).
  }, []);

  const handleSelect = async (organizationId: string) => {
    setSelectingId(organizationId);
    setSelectError(null);
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) {
      setSelectError(error.message ?? t("auth.selectOrg.genericError"));
      setSelectingId(null);
      return;
    }
    void navigate("/", { replace: true });
  };

  return (
    <AuthLayout title={t("auth.selectOrg.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {loadError && <Alert tone="error">{loadError}</Alert>}
        {selectError && <Alert tone="error">{selectError}</Alert>}
        {organizations === null && !loadError && (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spinner />
          </div>
        )}
        {organizations !== null && organizations.length === 0 && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("auth.selectOrg.empty")}
          </p>
        )}
        {organizations !== null && organizations.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              margin: 0,
              padding: 0,
            }}
          >
            {organizations.map((org) => (
              <li
                key={org.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{org.name}</span>
                <Button
                  size="compact"
                  variant="secondary"
                  loading={selectingId === org.id}
                  onClick={() => void handleSelect(org.id)}
                >
                  {t("auth.selectOrg.selectButton")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
          <Link to="/org/create">{t("auth.selectOrg.createNew")}</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
