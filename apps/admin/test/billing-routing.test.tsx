import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider, RequireCapability } from "../src/access/context.js";
import { appRoutes } from "../src/app.js";
import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { BillingLayout } from "../src/pages/billing/BillingLayout.js";

const ACTIVE_SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "owner@example.com", name: "Елена Ким" },
};

const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-ko" }];

const OWNER_ACCESS: AccessDocument = {
  roles: ["owner"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.BILLING_READ,
    CABINET_CAPABILITY.BILLING_REQUEST,
  ],
};

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.BILLING_READ,
    CABINET_CAPABILITY.BILLING_REQUEST,
  ],
};

const MANAGER_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const MEMBER_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [],
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function createAuthClient(): AuthClientLike {
  return {
    useSession: () => ({ data: ACTIVE_SESSION, isPending: false, error: null }),
    useListOrganizations: () => ({ data: ORGANIZATIONS, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: async () => ({ data: {}, error: null }),
    organization: {
      create: async () => ({ data: { id: "org_1" }, error: null }),
      list: async () => ({ data: ORGANIZATIONS, error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
  };
}

function renderRoute(path: string, access: AccessDocument) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/profile")) {
        return response({
          firstName: "Елена",
          lastName: "Ким",
          middleName: null,
          hasAvatar: false,
        });
      }
      if (url.endsWith("/api/access/me")) return response(access);
      if (url.includes("/api/pickup-orders")) return response({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={createAuthClient()}>
          <RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: [path] })} />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it.each([
  ["owner", OWNER_ACCESS],
  ["admin", ADMIN_ACCESS],
] as const)("shows billing navigation and request action for an %s", async (_role, access) => {
  renderRoute("/billing", access);

  expect(await screen.findByRole("link", { name: "Биллинг" })).toBeDefined();
  expect(screen.getByRole("heading", { name: "Биллинг" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Создать заявку" }).getAttribute("href")).toBe(
    "/billing/requests/new",
  );
  expect(
    within(screen.getByRole("navigation", { name: "Разделы биллинга" }))
      .getByRole("link", { name: "Обзор" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

it.each([
  ["manager", MANAGER_ACCESS],
  ["member", MEMBER_ACCESS],
] as const)("does not expose billing navigation to a %s", async (_role, access) => {
  renderRoute("/", access);

  if (access.capabilities.length === 0) {
    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
  } else {
    expect(await screen.findByRole("heading", { name: "Обзор" })).toBeDefined();
  }
  expect(screen.queryByRole("link", { name: "Биллинг" })).toBeNull();
});

it("forbids a manager from opening the billing route directly", async () => {
  renderRoute("/billing/requests", MANAGER_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Биллинг" })).toBeNull();
});

it("keeps the billing capability boundary for a member direct route", () => {
  render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter initialEntries={["/billing"]}>
        <AccessProvider value={MEMBER_ACCESS}>
          <RequireCapability capability={CABINET_CAPABILITY.BILLING_READ}>
            <BillingLayout />
          </RequireCapability>
        </AccessProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );

  expect(screen.getByTestId("forbidden-page")).toBeDefined();
});

it("redirects the saved subscription route to the canonical billing tab", async () => {
  renderRoute("/settings/subscription", OWNER_ACCESS);

  expect(await screen.findByRole("heading", { name: "Биллинг" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Подписка и лимиты" }).getAttribute("aria-current")).toBe(
    "page",
  );
});
