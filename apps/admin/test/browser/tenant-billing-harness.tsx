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

const session: SessionData = {
  session: { activeOrganizationId: "browser_org" },
  user: { id: "browser_owner", email: "owner@example.test", name: "Елена Ким" },
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
const initialEntry = new URLSearchParams(window.location.search).get("route") ?? "/billing";
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
