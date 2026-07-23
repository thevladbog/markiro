import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { createContext, createElement, useContext, type ReactNode } from "react";

/**
 * Narrow, hand-written contract for the subset of the Better Auth client
 * this app actually calls. Better Auth's real client type is a deep
 * generic inferred from the plugin list passed to `createAuthClient`
 * (see node_modules/better-auth/dist/client/react/index.d.mts), which is
 * impractical to satisfy with a plain object literal in tests. Pages depend
 * on this interface (injected via `AuthClientContext`) instead, so tests can
 * provide a trivial fake -- the real client is cast to it once, here.
 */
export interface SessionData {
  session: { activeOrganizationId?: string | null } & Record<string, unknown>;
  user: { id: string; email: string; name?: string | null } & Record<string, unknown>;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
}

export interface AuthActionResult<T> {
  data: T | null;
  error: { message?: string } | null;
}

export interface AuthClientLike {
  useSession: () => {
    data: SessionData | null | undefined;
    isPending: boolean;
    error: unknown;
  };
  signIn: {
    email: (input: { email: string; password: string }) => Promise<AuthActionResult<unknown>>;
  };
  signUp: {
    email: (input: {
      email: string;
      password: string;
      name: string;
    }) => Promise<AuthActionResult<unknown>>;
  };
  signOut: () => Promise<AuthActionResult<unknown>>;
  organization: {
    create: (input: { name: string; slug: string }) => Promise<AuthActionResult<{ id: string }>>;
    list: () => Promise<AuthActionResult<OrganizationSummary[]>>;
    setActive: (input: { organizationId: string | null }) => Promise<AuthActionResult<unknown>>;
  };
}

/**
 * No explicit `baseURL`: Better Auth's client only falls back to
 * `window.location.origin` when the option is omitted entirely -- passing an
 * explicit *relative* URL (e.g. "/api/auth") is rejected outright by its
 * `assertHasProtocol` check (see node_modules/better-auth/dist/utils/url.mjs),
 * it does not get resolved against the current origin. Omitting it means the
 * client targets `${window.location.origin}/api/auth` (its own default
 * path), which the Vite dev proxy forwards untouched to the API (see
 * vite.config.ts) -- so this and the API server share an origin from the
 * browser's point of view. Better Auth's createFetch sets `credentials: "include"`
 * by default (see node_modules/better-auth/dist/client/config.mjs), so the
 * session cookie is sent without extra config.
 */
const realAuthClient = createAuthClient({
  plugins: [organizationClient()],
}) as unknown as AuthClientLike;

export { realAuthClient as authClient };

const AuthClientContext = createContext<AuthClientLike>(realAuthClient);

export function AuthClientProvider({
  client,
  children,
}: {
  client: AuthClientLike;
  children: ReactNode;
}) {
  return createElement(AuthClientContext.Provider, { value: client }, children);
}

export function useAuthClient(): AuthClientLike {
  return useContext(AuthClientContext);
}
