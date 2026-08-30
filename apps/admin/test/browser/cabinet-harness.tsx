import "@markiro/ui/styles.css";
import "../../src/global.css";
import "../../src/i18n/index.js";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

import { ThemeProvider } from "@markiro/ui";

import { appRoutes } from "../../src/app.js";
import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../../src/auth/client.js";

/**
 * Synthetic session for the cabinet browser harness: a manager-level user in
 * the "Марка Ко" organization shared by every cabinet evidence suite.
 * Capabilities themselves are NOT injected here -- `RequireCapability`
 * (apps/admin/src/access/context.tsx) reads them from `AccessProvider`,
 * which `pages/Shell.tsx` populates from `GET /api/access/me` through
 * `useAccessDocument`. Each Playwright spec mocks that endpoint with the
 * role it needs (role "manager" -> operations.read + operations.write, see
 * packages/domain/src/access/cabinet.ts's `ROLE_CAPABILITIES`), exactly like
 * the tenant-billing precedent mocks `/api/access/me` for its own roles.
 *
 * The screen under test comes from `?route=`; every spec passes it
 * explicitly, so the fallback below is only a safe landing page.
 */
const session: SessionData = {
  session: { activeOrganizationId: "browser_org" },
  user: { id: "browser_manager", email: "manager@example.test", name: "Игорь Волков" },
};
const organizations: OrganizationSummary[] = [
  { id: "browser_org", name: "Марка Ко", slug: "marka-ko" },
];
const authClient: AuthClientLike = {
  useSession: () => ({ data: session, isPending: false, error: null }),
  useListOrganizations: () => ({ data: organizations, isPending: false, error: null }),
  signIn: { email: async () => ({ data: {}, error: null }) },
  signUp: { email: async () => ({ data: {}, error: null }) },
  resetPassword: async () => ({ data: { status: true }, error: null }),
  signOut: async () => ({ data: {}, error: null }),
  organization: {
    create: async () => ({ data: { id: "browser_org" }, error: null }),
    list: async () => ({ data: organizations, error: null }),
    setActive: async () => ({ data: {}, error: null }),
  },
};

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");
const initialEntry = new URLSearchParams(window.location.search).get("route") ?? "/";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

createRoot(container).render(
  <ThemeProvider defaultTheme="light">
    <QueryClientProvider client={queryClient}>
      <AuthClientProvider client={authClient}>
        <RouterProvider
          router={createMemoryRouter(appRoutes, { initialEntries: [initialEntry] })}
        />
      </AuthClientProvider>
    </QueryClientProvider>
  </ThemeProvider>,
);
