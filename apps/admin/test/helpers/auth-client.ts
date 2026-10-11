import type { AuthClientLike } from "../../src/auth/client.js";

/**
 * An inert auth client for tests that render pages reading the session but do
 * not exercise sign-in: nobody is signed in and every action succeeds without a
 * request. Inject it with `AuthClientProvider`; the real Better Auth client is
 * off limits in tests (see `test/setup.ts`).
 */
export function inertAuthClient(): AuthClientLike {
  return {
    useSession: () => ({ data: null, isPending: false, error: null, refetch: async () => {} }),
    useListOrganizations: () => ({ data: [], isPending: false, error: null }),
    signIn: { email: async () => ({ data: null, error: null }) },
    signUp: { email: async () => ({ data: null, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: async () => ({ data: null, error: null }),
    organization: {
      create: async () => ({ data: { id: "org-1" }, error: null }),
      list: async () => ({ data: [], error: null }),
      setActive: async () => ({ data: null, error: null }),
    },
  };
}
