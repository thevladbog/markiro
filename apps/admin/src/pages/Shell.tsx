import { Navigate } from "react-router";

import { Spinner } from "@markiro/ui";

import { useAuthClient } from "../auth/client.js";
import { AppShell } from "../layout/AppShell.js";

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

  return <AppShell />;
}
