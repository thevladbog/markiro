import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import { ShellPage } from "../src/pages/Shell.js";

afterEach(() => {
  cleanup();
});

/** A fully-fake AuthClientLike -- no network, no better-auth internals. */
function createFakeAuthClient(overrides: Partial<AuthClientLike> = {}): AuthClientLike {
  return {
    useSession: () => ({ data: null, isPending: false, error: null }),
    useListOrganizations: () => ({ data: [], isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    signOut: async () => ({ data: {}, error: null }),
    organization: {
      create: async () => ({ data: { id: "org_1" }, error: null }),
      list: async () => ({ data: [] as OrganizationSummary[], error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
    ...overrides,
  };
}

/**
 * Renders ShellPage in a MemoryRouter with routes for shell, login, and org/select.
 * Also provides a location-tracking component to verify navigation.
 */
function renderShell(client: AuthClientLike) {
  function LocationTracker() {
    const location = useLocation();
    return <div data-testid="location-pathname">{location.pathname}</div>;
  }

  return render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter initialEntries={["/shell"]}>
        <LocationTracker />
        <AuthClientProvider client={client}>
          <Routes>
            <Route path="/shell" element={<ShellPage />} />
            <Route path="/login" element={<div data-testid="login-page">LOGIN_PAGE</div>} />
            <Route
              path="/org/select"
              element={<div data-testid="org-select-page">ORG_SELECT_PAGE</div>}
            />
          </Routes>
        </AuthClientProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("ShellPage", () => {
  it("renders spinner when loading (isPending=true), does not redirect", () => {
    const client = createFakeAuthClient({
      useSession: () => ({ data: undefined, isPending: true, error: null }),
    });
    renderShell(client);

    // Verify spinner is rendered
    expect(screen.getByRole("status")).toBeDefined();

    // Verify no redirect occurred -- location should still be /shell
    const locationPathname = screen.getByTestId("location-pathname");
    expect(locationPathname.textContent).toBe("/shell");
  });

  it("redirects to /login when session is null (no session)", async () => {
    const client = createFakeAuthClient({
      useSession: () => ({ data: null, isPending: false, error: null }),
    });
    renderShell(client);

    // Verify redirect to /login occurred
    await waitFor(() => {
      expect(screen.getByTestId("login-page")).toBeDefined();
    });

    const locationPathname = screen.getByTestId("location-pathname");
    expect(locationPathname.textContent).toBe("/login");
  });

  it("redirects to /org/select when session exists but activeOrganizationId is missing", async () => {
    const session: SessionData = {
      session: { activeOrganizationId: null },
      user: { id: "user_1", email: "user@example.com", name: "User" },
    };
    const client = createFakeAuthClient({
      useSession: () => ({ data: session, isPending: false, error: null }),
    });
    renderShell(client);

    // Verify redirect to /org/select occurred
    await waitFor(() => {
      expect(screen.getByTestId("org-select-page")).toBeDefined();
    });

    const locationPathname = screen.getByTestId("location-pathname");
    expect(locationPathname.textContent).toBe("/org/select");
  });

  it("renders the app shell (sidebar + header) when session has activeOrganizationId", async () => {
    const session: SessionData = {
      session: { activeOrganizationId: "org_1" },
      user: { id: "user_1", email: "user@example.com", name: "User" },
    };
    const client = createFakeAuthClient({
      useSession: () => ({ data: session, isPending: false, error: null }),
      useListOrganizations: () => ({
        data: [{ id: "org_1", name: "Test Org", slug: "test-org" }],
        isPending: false,
        error: null,
      }),
    });
    renderShell(client);

    // Sidebar nav item, resolved org name (via useListOrganizations), signed-in
    // user's email, and the sign-out button all come from the real AppShell now
    // (the Task 9 placeholder content is gone). The email appears twice (header
    // + sidebar footer), so assert at least one match rather than a unique one.
    expect(screen.getByRole("link", { name: "Обзор" })).toBeDefined();
    expect(await screen.findByText("Test Org")).toBeDefined();
    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Выйти|Sign out/i })).toBeDefined();

    // Verify no redirect occurred -- location should still be /shell
    const locationPathname = screen.getByTestId("location-pathname");
    expect(locationPathname.textContent).toBe("/shell");
  });
});
