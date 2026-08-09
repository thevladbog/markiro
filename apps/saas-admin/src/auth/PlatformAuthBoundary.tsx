import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Spinner } from "@markiro/ui";

import { ApiRequestError, platformApiFetch } from "../api/client.js";
import { useAuthClient } from "./client.js";
import { isPlatformChallengePending } from "./challenge.js";

export type PlatformRole = "platform_admin" | "support" | "accountant";
export type PlatformCapability =
  | "tenants.read"
  | "tenants.write"
  | "catalog.read"
  | "catalog.write"
  | "billing.read"
  | "billing.write"
  | "platformTeam.write"
  | "audit.read";

export interface PlatformPrincipal {
  userId: string;
  role: PlatformRole;
  capabilities: readonly PlatformCapability[];
  twoFactorReady: boolean;
}

const PrincipalContext = createContext<PlatformPrincipal | null>(null);

export function usePlatformPrincipal(): PlatformPrincipal {
  const principal = useContext(PrincipalContext);
  if (!principal) throw new Error("Platform principal is unavailable outside the auth boundary");
  return principal;
}

function AuthStateFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-state" id="main-content">
      <Card className="auth-state__card">{children}</Card>
    </main>
  );
}

export function PlatformAuthBoundary() {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const session = auth.useSession();
  const location = useLocation();
  const principal = useQuery({
    queryKey: ["platform", "me", session.data?.user.id],
    queryFn: () => platformApiFetch<PlatformPrincipal>("/me"),
    enabled: Boolean(session.data && session.data.user.twoFactorEnabled !== false),
    staleTime: 30_000,
  });

  if (session.isPending) {
    return (
      <AuthStateFrame>
        <div className="auth-state__loading">
          <Spinner label={t("auth.boundary.loading")} />
          <span>{t("auth.boundary.loading")}</span>
        </div>
      </AuthStateFrame>
    );
  }

  if (session.error) {
    return (
      <AuthStateFrame>
        <Alert title={t("auth.boundary.networkTitle")} tone="error">
          {t("auth.boundary.networkBody")}
        </Alert>
      </AuthStateFrame>
    );
  }

  if (!session.data) {
    if (isPlatformChallengePending()) {
      return <Navigate to="/two-factor?mode=challenge" replace />;
    }
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (session.data.user.twoFactorEnabled === false) {
    return <Navigate to="/two-factor?mode=enroll" replace />;
  }

  if (principal.isPending) {
    return (
      <AuthStateFrame>
        <div className="auth-state__loading">
          <Spinner label={t("auth.boundary.accessLoading")} />
          <span>{t("auth.boundary.accessLoading")}</span>
        </div>
      </AuthStateFrame>
    );
  }

  if (principal.error) {
    if (principal.error instanceof ApiRequestError && principal.error.status === 401) {
      return <Navigate to="/login" replace />;
    }
    if (principal.error instanceof ApiRequestError && principal.error.status === 403) {
      return (
        <AuthStateFrame>
          <h1>{t("auth.boundary.forbiddenTitle")}</h1>
          <p>{t("auth.boundary.forbiddenBody")}</p>
          <Button onClick={() => void auth.signOut()}>{t("auth.signOut")}</Button>
        </AuthStateFrame>
      );
    }
    return (
      <AuthStateFrame>
        <Alert title={t("auth.boundary.apiTitle")} tone="error">
          {t("auth.boundary.apiBody")}
        </Alert>
      </AuthStateFrame>
    );
  }

  if (!principal.data?.twoFactorReady) {
    return <Navigate to="/two-factor?mode=enroll" replace />;
  }

  return (
    <PrincipalContext.Provider value={principal.data}>
      <Outlet />
    </PrincipalContext.Provider>
  );
}
