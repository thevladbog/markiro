import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { createContext, createElement, useContext, type ReactNode } from "react";

export interface PlatformSessionData {
  session: { id?: string } & Record<string, unknown>;
  user: {
    id: string;
    email: string;
    name?: string | null;
    twoFactorEnabled?: boolean;
  } & Record<string, unknown>;
}

export interface AuthActionResult<T> {
  data: T | null;
  error: { message?: string; code?: string } | null;
}

export interface AuthClientLike {
  useSession: () => {
    data: PlatformSessionData | null | undefined;
    isPending: boolean;
    error: unknown;
    refetch?: () => Promise<unknown>;
  };
  signIn: {
    email: (input: {
      email: string;
      password: string;
    }) => Promise<AuthActionResult<{ twoFactorRedirect?: boolean }>>;
  };
  signOut: () => Promise<AuthActionResult<{ success?: boolean }>>;
  revokeOtherSessions: () => Promise<AuthActionResult<{ status?: boolean }>>;
  twoFactor: {
    enable: (input: {
      password: string;
    }) => Promise<AuthActionResult<{ totpURI: string; backupCodes: string[] }>>;
    verifyTotp: (input: {
      code: string;
      trustDevice: boolean;
    }) => Promise<AuthActionResult<unknown>>;
    verifyBackupCode: (input: {
      code: string;
      trustDevice: boolean;
    }) => Promise<AuthActionResult<unknown>>;
    disable: (input: { password: string }) => Promise<AuthActionResult<{ status: boolean }>>;
  };
}

const realAuthClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  basePath: "/api/platform-auth",
  plugins: [twoFactorClient()],
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
