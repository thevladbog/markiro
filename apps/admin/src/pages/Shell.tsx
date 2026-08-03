import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router";

import { Button, EmptyState, Spinner } from "@markiro/ui";

import { useAccessDocument } from "../access/api.js";
import { AccessProvider } from "../access/context.js";
import { NoCabinetAccess } from "../access/NoCabinetAccess.js";
import { ApiRequestError } from "../api/client.js";
import { useAuthClient } from "../auth/client.js";
import { AppShell } from "../layout/AppShell.js";
import { useProfile } from "./profile/api.js";

/**
 * Guarded root route: redirects to /login (no session) or /org/select
 * (session without an active organization); otherwise renders the real app
 * shell (`layout/AppShell.tsx` -- sidebar, header, routed `<Outlet/>`
 * content per `app.tsx`'s nested "/" route).
 */
export function ShellPage() {
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
    <ProfileCompletionGate
      userId={session.user.id}
      activeOrganizationId={session.session.activeOrganizationId}
    />
  );
}

function ProfileCompletionGate({
  userId,
  activeOrganizationId,
}: {
  userId: string;
  activeOrganizationId: string;
}) {
  const location = useLocation();
  const profile = useProfile();

  if (profile.isPending) return <CenteredSpinner />;
  if (profile.isError || !profile.data) {
    return <AccessLoadError onRetry={() => void profile.refetch()} />;
  }
  if (!profile.data.firstName?.trim() || !profile.data.lastName?.trim()) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/profile?complete=1&returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return <AccessGate userId={userId} activeOrganizationId={activeOrganizationId} />;
}

function AccessGate({
  userId,
  activeOrganizationId,
}: {
  userId: string;
  activeOrganizationId: string;
}) {
  const access = useAccessDocument(userId, activeOrganizationId);

  if (access.isPending) return <CenteredSpinner />;
  if (access.error instanceof ApiRequestError && access.error.status === 403) {
    return <NoCabinetAccess />;
  }
  if (access.isError || !access.data)
    return <AccessLoadError onRetry={() => void access.refetch()} />;
  if (access.data.capabilities.length === 0) return <NoCabinetAccess />;

  return (
    <AccessProvider value={access.data}>
      <AppShell />
    </AccessProvider>
  );
}

function CenteredSpinner() {
  const { t } = useTranslation();

  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 96 }}>
      <Spinner label={t("access.loading")} />
    </div>
  );
}

function AccessLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div style={{ padding: "48px 32px" }}>
      <EmptyState
        title={t("access.loadErrorTitle")}
        hint={t("access.loadErrorBody")}
        action={<Button onClick={onRetry}>{t("access.retry")}</Button>}
      />
    </div>
  );
}
