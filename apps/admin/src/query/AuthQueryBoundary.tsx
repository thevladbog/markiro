import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";

import { useAuthClient, type SessionData } from "../auth/client.js";

function identityKey(session: SessionData | null | undefined, isPending: boolean): string {
  if (isPending) return JSON.stringify(["session-pending"]);
  if (!session) return JSON.stringify(["anonymous"]);
  return JSON.stringify([
    "authenticated",
    session.user.id,
    session.session.activeOrganizationId ?? null,
  ]);
}

function IdentityQueryClient({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/**
 * Gives every authenticated user/organization pair a structurally separate
 * query cache. A session refresh enters its own empty boundary as well, so
 * stale authenticated data is never rendered while identity is unresolved.
 */
export function AuthQueryBoundary({ children }: { children: ReactNode }) {
  const authClient = useAuthClient();
  const session = authClient.useSession();
  const key = identityKey(session.data, session.isPending);

  return <IdentityQueryClient key={key}>{children}</IdentityQueryClient>;
}

/** Clears every query and mutation owned by the current auth identity. */
export function useClearAuthQueryCache(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.clear(), [queryClient]);
}
