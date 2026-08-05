import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { CatalogPage } from "../src/pages/catalog/index.js";
import { CounterpartiesPage } from "../src/pages/counterparties/index.js";
import { DashboardPage } from "../src/pages/dashboard/index.js";
import { SettingsPage } from "../src/pages/settings/index.js";
import { ShiftsPage } from "../src/pages/shifts/index.js";
import { ShellPage } from "../src/pages/Shell.js";

const ACTIVE_SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};

const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-co" }];

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  localStorage.clear();
  // AppShell's nav badge reads usePendingOrderCount() (Task 14), which fires
  // a GET /pickup-orders?status=pending on every render regardless of route
  // -- stub it to an empty list so these layout/navigation tests don't hit
  // the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/profile")) {
        return jsonResponse(200, {
          firstName: "Елена",
          lastName: "Ким",
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
      if (
        url.endsWith("/api/products") ||
        url.endsWith("/api/shifts") ||
        url.endsWith("/api/lines") ||
        url.endsWith("/api/conflicts?reviewed=false")
      ) {
        return jsonResponse(200, { items: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

/** A fully-fake AuthClientLike -- no network, no better-auth internals. */
function createFakeAuthClient(overrides: Partial<AuthClientLike> = {}): AuthClientLike {
  return {
    useSession: () => ({ data: ACTIVE_SESSION, isPending: false, error: null }),
    useListOrganizations: () => ({ data: ORGANIZATIONS, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: vi.fn(async () => ({ data: {}, error: null })),
    organization: {
      create: async () => ({ data: { id: "org_1" }, error: null }),
      list: async () => ({ data: ORGANIZATIONS, error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
    ...overrides,
  };
}

/**
 * Renders the same guarded/nested route tree as `app.tsx` (`/` -> `ShellPage`
 * -> `AppShell` -> `<Outlet/>` children), wrapped in `ThemeProvider` (so the
 * header's theme toggle has a context to write to) and a location tracker
 * (so sign-out's redirect is observable).
 */
function renderApp(client: AuthClientLike, initialPath = "/") {
  function LocationTracker() {
    const location = useLocation();
    return <div data-testid="location-pathname">{location.pathname}</div>;
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={[initialPath]}>
          <LocationTracker />
          <AuthClientProvider client={client}>
            <Routes>
              <Route path="/login" element={<div data-testid="login-page">LOGIN_PAGE</div>} />
              <Route path="/" element={<ShellPage />}>
                <Route index element={<DashboardPage />} />
                <Route path="catalog" element={<CatalogPage />} />
                <Route path="shifts" element={<ShiftsPage />} />
                <Route path="counterparties" element={<CounterpartiesPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </AuthClientProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("app shell layout", () => {
  it("renders operational manager nav items and hides privileged sections", async () => {
    renderApp(createFakeAuthClient());

    const expectedLinks: Array<[string, string]> = [
      ["Обзор", "/"],
      ["Каталог", "/catalog"],
      ["Смены", "/shifts"],
      ["Контрагенты", "/counterparties"],
      ["Операторы и сотрудники", "/employees"],
      ["Этикетки", "/labels"],
      ["Для себя", "/pickup"],
    ];
    for (const [label, href] of expectedLinks) {
      const link = await screen.findByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
    }
    expect(screen.getByText("Производство")).toBeDefined();
    expect(screen.getByText("Справочники")).toBeDefined();
    expect(screen.getByText("Оборудование и обмен")).toBeDefined();
    expect(screen.queryByText("Организация")).toBeNull();
    expect(screen.queryByRole("link", { name: "Интеграции" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Настройки" })).toBeNull();
  });

  it("dashboard guides a new organization to its first product", async () => {
    renderApp(createFakeAuthClient());
    expect(await screen.findByRole("heading", { name: "Подготовьте первую смену" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Добавить продукт" }).getAttribute("href")).toBe(
      "/catalog",
    );
  });

  it("waits for sign-out to settle before redirecting to /login", async () => {
    let resolveSignOut!: (value: { data: unknown; error: null }) => void;
    const signOutResult = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveSignOut = resolve;
    });
    const signOut = vi.fn(() => signOutResult);
    renderApp(createFakeAuthClient({ signOut }));

    const signOutButton = await screen.findByRole("button", { name: /Выйти|Sign out/i });
    fireEvent.click(signOutButton);
    fireEvent.click(signOutButton);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOutButton.querySelector(".mk-spin")).not.toBeNull();
    expect(screen.queryByTestId("login-page")).toBeNull();

    await act(async () => resolveSignOut({ data: {}, error: null }));

    expect(await screen.findByTestId("login-page")).toBeDefined();
    expect(screen.getByTestId("location-pathname").textContent).toBe("/login");
  });

  it("theme toggle flips documentElement data-theme", async () => {
    renderApp(createFakeAuthClient());
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(await screen.findByRole("button", { name: "Переключить тему" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("lang toggle switches a visible label to EN", async () => {
    renderApp(createFakeAuthClient());
    expect(await screen.findByRole("link", { name: "Обзор" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Переключить язык" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Overview" })).toBeDefined();
    });
  });
});
