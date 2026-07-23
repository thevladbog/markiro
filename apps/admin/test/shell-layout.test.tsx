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

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ru");
});

/** A fully-fake AuthClientLike -- no network, no better-auth internals. */
function createFakeAuthClient(overrides: Partial<AuthClientLike> = {}): AuthClientLike {
  return {
    useSession: () => ({ data: ACTIVE_SESSION, isPending: false, error: null }),
    useListOrganizations: () => ({ data: ORGANIZATIONS, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
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

  return render(
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
    </ThemeProvider>,
  );
}

describe("app shell layout", () => {
  it("renders all five nav items from the RU dictionary with correct hrefs", () => {
    renderApp(createFakeAuthClient());

    const expectedLinks: Array<[string, string]> = [
      ["Обзор", "/"],
      ["Каталог", "/catalog"],
      ["Смены", "/shifts"],
      ["Контрагенты", "/counterparties"],
      ["Настройки", "/settings"],
    ];
    for (const [label, href] of expectedLinks) {
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
    }
  });

  it("dashboard stub shows an EmptyState", () => {
    renderApp(createFakeAuthClient());
    expect(screen.getByText("Пока нет данных")).toBeDefined();
  });

  it("sign-out calls the injected auth client and redirects to /login", async () => {
    const signOut = vi.fn(async () => ({ data: {}, error: null }));
    renderApp(createFakeAuthClient({ signOut }));

    fireEvent.click(screen.getByRole("button", { name: /Выйти|Sign out/i }));

    await waitFor(() => {
      expect(screen.getByTestId("login-page")).toBeDefined();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location-pathname").textContent).toBe("/login");
  });

  it("theme toggle flips documentElement data-theme", () => {
    renderApp(createFakeAuthClient());
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Переключить тему" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("lang toggle switches a visible label to EN", async () => {
    renderApp(createFakeAuthClient());
    expect(screen.getByRole("link", { name: "Обзор" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Переключить язык" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Overview" })).toBeDefined();
    });
  });
});
