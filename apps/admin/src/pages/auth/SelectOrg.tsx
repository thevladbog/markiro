import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { Alert, Button } from "@markiro/ui";

import { useAuthClient, type OrganizationSummary } from "../../auth/client.js";
import { useClearAuthQueryCache } from "../../query/AuthQueryBoundary.js";
import { AccountShell } from "../account/AccountShell.js";

export function SelectOrgPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const clearAuthQueryCache = useClearAuthQueryCache();
  const { data: session } = authClient.useSession();

  const [organizations, setOrganizations] = useState<OrganizationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [activatedId, setActivatedId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  useEffect(() => {
    if (activatedId && session?.session.activeOrganizationId === activatedId) {
      void navigate("/", { replace: true });
    }
  }, [activatedId, navigate, session?.session.activeOrganizationId]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: `t` is read only in the error paths, and re-listing the orgs on a language change would clobber the current selection.
  }, []);

  const handleSelect = async (organizationId: string) => {
    if (selectingId) return;
    setSelectingId(organizationId);
    setSelectError(null);
    clearAuthQueryCache();
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) {
      setSelectError(error.message ?? t("auth.selectOrg.genericError"));
      setSelectingId(null);
      return;
    }
    setActivatedId(organizationId);
  };

  const handleBack = async () => {
    if (session?.session.activeOrganizationId) {
      void navigate("/", { replace: true });
      return;
    }
    clearAuthQueryCache();
    try {
      await authClient.signOut();
    } finally {
      void navigate("/login", { replace: true });
    }
  };

  const activeOrganizationId = session?.session.activeOrganizationId ?? null;

  return (
    <AccountShell
      eyebrow={t("account.eyebrow")}
      title={t("auth.selectOrg.title")}
      description={t("auth.selectOrg.description")}
      accountLabel={session?.user.email ?? t("account.unknownUser")}
      backLabel={activeOrganizationId ? t("account.backToWorkspace") : t("account.signOutToLogin")}
      onBack={handleBack}
    >
      {selectError ? (
        <div className="mk-account-alert">
          <Alert tone="error">{selectError}</Alert>
        </div>
      ) : null}
      <div className="mk-account-frame">
        <div className="mk-account-panel">
          <header className="mk-account-panel__header">
            <div>
              <h2>{t("auth.selectOrg.listTitle")}</h2>
              <p>{t("auth.selectOrg.listHint")}</p>
            </div>
            {organizations ? (
              <span className="mk-account-page__eyebrow">
                {t("auth.selectOrg.count", { count: organizations.length })}
              </span>
            ) : null}
          </header>

          {loadError ? (
            <div className="mk-account-list__error">
              <Alert tone="error">{loadError}</Alert>
            </div>
          ) : null}
          {organizations === null && !loadError ? (
            <div className="mk-account-skeleton" role="status" aria-label={t("common.loading")}>
              <span />
              <span />
            </div>
          ) : null}
          {organizations?.length === 0 ? (
            <p className="mk-account-list__empty">{t("auth.selectOrg.empty")}</p>
          ) : null}
          {organizations && organizations.length > 0 ? (
            <ul className="mk-account-list">
              {organizations.map((org) => {
                const current = org.id === activeOrganizationId;
                const selecting = selectingId === org.id;
                return (
                  <li className="mk-account-org-shell" key={org.id}>
                    <Button
                      className="mk-account-org"
                      variant="secondary"
                      fullWidth
                      aria-label={t("auth.selectOrg.openNamed", { name: org.name })}
                      aria-busy={selecting || undefined}
                      disabled={selectingId !== null}
                      onClick={() => void handleSelect(org.id)}
                    >
                      <span className="mk-account-org__mark" aria-hidden="true">
                        {initialsOf(org.name)}
                      </span>
                      <span className="mk-account-org__copy">
                        <strong>{org.name}</strong>
                        <code>{org.slug}</code>
                      </span>
                      {current ? (
                        <span className="mk-account-org__current">
                          {t("auth.selectOrg.current")}
                        </span>
                      ) : null}
                      <span className="mk-account-action__icon" aria-hidden="true">
                        {selecting ? (
                          <span className="mk-account-org__progress">•••</span>
                        ) : (
                          <svg viewBox="0 0 20 20" focusable="false">
                            <path d="M4 10h11M10.5 5.5 15 10l-4.5 4.5" />
                          </svg>
                        )}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <footer className="mk-account-panel__footer">
            <p>{t("auth.selectOrg.createHint")}</p>
            <Link className="mk-account-link" to="/org/create">
              {t("auth.selectOrg.createNew")}
            </Link>
          </footer>
        </div>
      </div>
    </AccountShell>
  );
}

function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}
