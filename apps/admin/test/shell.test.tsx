import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import { ShellPage } from "../src/pages/Shell.js";

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  // AppShell's nav badge reads usePendingOrderCount() (Task 14), which fires
  // a GET /pickup-orders?status=pending whenever the real shell renders --
  // stub it so these guard tests don't hit the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/profile")) {
        return jsonResponse(200, {
          firstName: "Test",
          lastName: "User",
          middleName: null,
          hasAvatar: false,
        });
      }
      if (url.endsWith("/api/access/me")) {
        return jsonResponse(200, {
          roles: ["manager"],
          capabilities: ["operations.read", "operations.write"],
        });
      }
      if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
function renderShell(client: AuthClientLike, queryClient?: QueryClient) {
  function LocationTracker() {
    const location = useLocation();
    return <div data-testid="location-pathname">{location.pathname}</div>;
  }

  const testQueryClient =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

  return render(
    <QueryClientProvider client={testQueryClient}>
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
      </ThemeProvider>
    </QueryClientProvider>,
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
    expect(await screen.findByRole("link", { name: "Обзор" })).toBeDefined();
    expect(await screen.findByText("Test Org")).toBeDefined();
    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Выйти|Sign out/i })).toBeDefined();

    // Verify no redirect occurred -- location should still be /shell
    const locationPathname = screen.getByTestId("location-pathname");
    expect(locationPathname.textContent).toBe("/shell");
  });

  it("waits for access before mounting the operational shell", async () => {
    let resolveAccess: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return Promise.resolve(
            jsonResponse(200, {
              firstName: "Test",
              lastName: "User",
              middleName: null,
              hasAvatar: false,
            }),
          );
        }
        if (url.endsWith("/api/access/me")) {
          return new Promise<Response>((resolve) => {
            resolveAccess = resolve;
          });
        }
        if (url.includes("/api/pickup-orders"))
          return Promise.resolve(jsonResponse(200, { items: [] }));
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }),
    );
    const client = createFakeAuthClient({
      useSession: () => ({
        data: {
          session: { activeOrganizationId: "org_1" },
          user: { id: "user_1", email: "user@example.com", name: "User" },
        },
        isPending: false,
        error: null,
      }),
    });

    renderShell(client);

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Обзор" })).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toContain("/api/access/me");

    resolveAccess?.(
      jsonResponse(200, {
        roles: ["manager"],
        capabilities: ["operations.read", "operations.write"],
      }),
    );
  });

  it("shows no-access state instead of the sidebar for a member without cabinet access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) {
          return jsonResponse(200, { roles: ["member"], capabilities: [] });
        }
        if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderShell(
      createFakeAuthClient({
        useSession: () => ({
          data: {
            session: { activeOrganizationId: "org_1" },
            user: { id: "user_1", email: "user@example.com", name: "User" },
          },
          isPending: false,
          error: null,
        }),
      }),
    );

    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Обзор" })).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("treats a 403 access response as intentional no-access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) return jsonResponse(403, { message: "Forbidden" });
        if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderShell(
      createFakeAuthClient({
        useSession: () => ({
          data: {
            session: { activeOrganizationId: "org_1" },
            user: { id: "user_1", email: "user@example.com", name: "User" },
          },
          isPending: false,
          error: null,
        }),
      }),
      new QueryClient(),
    );

    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Обзор" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
      "/api/profile",
      "/api/access/me",
    ]);
  });

  it("shows a retryable load error for non-403 access failures", async () => {
    let accessCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) {
          accessCalls += 1;
          return jsonResponse(500, { message: "Server error" });
        }
        if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderShell(
      createFakeAuthClient({
        useSession: () => ({
          data: {
            session: { activeOrganizationId: "org_1" },
            user: { id: "user_1", email: "user@example.com", name: "User" },
          },
          isPending: false,
          error: null,
        }),
      }),
    );

    expect(await screen.findByText("Не удалось проверить доступ")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(accessCalls).toBe(2));
  });

  it("refetches access when the active organization changes", async () => {
    let activeOrganizationId = "org_1";
    const client = createFakeAuthClient({
      useSession: () => ({
        data: {
          session: { activeOrganizationId },
          user: { id: "user_1", email: "user@example.com", name: "User" },
        },
        isPending: false,
        error: null,
      }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const renderForActiveOrganization = () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme="light">
          <MemoryRouter initialEntries={["/shell"]}>
            <AuthClientProvider client={client}>
              <Routes>
                <Route path="/shell" element={<ShellPage />} />
              </Routes>
            </AuthClientProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    );
    const rendered = render(renderForActiveOrganization());

    await screen.findByRole("link", { name: "Обзор" });
    activeOrganizationId = "org_2";
    rendered.rerender(renderForActiveOrganization());

    await waitFor(() => {
      const requestedUrls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      expect(requestedUrls.filter((url) => url.endsWith("/api/access/me"))).toHaveLength(2);
    });
  });

  it("keeps the shell pending when the user changes inside the same organization", async () => {
    let userId = "admin_a";
    let resolveNextAccess!: (response: Response) => void;
    let accessCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return Promise.resolve(
            jsonResponse(200, {
              firstName: "Test",
              lastName: "User",
              middleName: null,
              hasAvatar: false,
            }),
          );
        }
        if (url.endsWith("/api/access/me")) {
          accessCalls += 1;
          if (accessCalls === 1) {
            return Promise.resolve(
              jsonResponse(200, {
                roles: ["admin"],
                capabilities: [
                  "operations.read",
                  "operations.write",
                  "integrations.read",
                  "integrations.write",
                  "tenant.settings.manage",
                  "credentials.manage",
                ],
              }),
            );
          }
          return new Promise<Response>((resolve) => {
            resolveNextAccess = resolve;
          });
        }
        if (url.includes("/api/pickup-orders")) {
          return Promise.resolve(jsonResponse(200, { items: [] }));
        }
        return Promise.reject(new Error(`Unexpected request: ${url}`));
      }),
    );
    const client = createFakeAuthClient({
      useSession: () => ({
        data: {
          session: { activeOrganizationId: "org_1" },
          user: { id: userId, email: `${userId}@example.com`, name: userId },
        },
        isPending: false,
        error: null,
      }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const renderForUser = () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme="light">
          <MemoryRouter initialEntries={["/shell"]}>
            <AuthClientProvider client={client}>
              <Routes>
                <Route path="/shell" element={<ShellPage />} />
              </Routes>
            </AuthClientProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    );
    const rendered = render(renderForUser());

    expect(await screen.findByRole("link", { name: "Интеграции" })).toBeDefined();

    userId = "member_b";
    rendered.rerender(renderForUser());

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Интеграции" })).toBeNull();
    expect(accessCalls).toBe(2);

    resolveNextAccess(jsonResponse(200, { roles: ["member"], capabilities: [] }));
    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
  });

  it("clears cached tenant data before no-access recovery actions leave the organization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) {
          return jsonResponse(200, { roles: ["member"], capabilities: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    let resolveSignOut!: (value: { data: unknown; error: null }) => void;
    const signOutResult = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveSignOut = resolve;
    });
    const signOut = vi.fn(() => signOutResult);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["tenant-secret"], "ORG_1_SECRET");
    const client = createFakeAuthClient({
      useSession: () => ({
        data: {
          session: { activeOrganizationId: "org_1" },
          user: { id: "member_1", email: "member@example.com", name: "Member" },
        },
        isPending: false,
        error: null,
      }),
      signOut,
    });
    const first = renderShell(client, queryClient);

    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать организацию" }));

    expect(queryClient.getQueryData(["tenant-secret"])).toBeUndefined();
    expect(screen.getByTestId("location-pathname").textContent).toBe("/org/select");
    first.unmount();

    queryClient.setQueryData(["tenant-secret"], "ORG_1_SECRET");
    renderShell(client, queryClient);
    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
    const signOutButton = screen.getByRole("button", { name: /Выйти|Sign out/i });
    fireEvent.click(signOutButton);
    fireEvent.click(signOutButton);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOutButton.querySelector(".mk-spin")).not.toBeNull();
    expect(queryClient.getQueryData(["tenant-secret"])).toBeUndefined();
    expect(screen.getByTestId("location-pathname").textContent).toBe("/shell");

    resolveSignOut({ data: {}, error: null });
    await waitFor(() => {
      expect(screen.getByTestId("location-pathname").textContent).toBe("/login");
    });
  });
});
