import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { AccessDocument } from "../src/access/api.js";
import { appRoutes } from "../src/app.js";
import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";

const ACTIVE_SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};

const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-co" }];

const MANAGER_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.INTEGRATIONS_READ,
    CABINET_CAPABILITY.INTEGRATIONS_WRITE,
    CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
    CABINET_CAPABILITY.MEMBERS_MANAGE,
  ],
};

const INTEGRATIONS_ONLY_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.INTEGRATIONS_READ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function createFakeAuthClient(): AuthClientLike {
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

function renderAccessRoute(
  initialPath: string,
  access: AccessDocument,
  profile: {
    firstName: string | null;
    lastName: string | null;
    middleName: string | null;
    hasAvatar: boolean;
  } = { firstName: "Елена", lastName: "Ким", middleName: null, hasAvatar: false },
) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/profile")) return jsonResponse(200, profile);
      if (path.endsWith("/api/access/me")) return jsonResponse(200, access);

      requests.push(path);
      if (path.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/integrations")) return jsonResponse(200, { channels: [] });
      if (path.endsWith("/api/org/profile")) {
        return jsonResponse(200, { gln: null, gs1Prefixes: [], inn: null });
      }
      if (path.endsWith("/api/products")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/counterparties")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/label-templates")) return jsonResponse(200, { items: [] });
      if (path.includes("/api/integrations/commerceml/candidates")) {
        return jsonResponse(200, { candidates: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={createFakeAuthClient()}>
          <RouterProvider
            router={createMemoryRouter(appRoutes, { initialEntries: [initialPath] })}
          />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );

  return { ...view, requests };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps operational navigation for managers while hiding integrations and settings", async () => {
  renderAccessRoute("/", MANAGER_ACCESS);

  expect(await screen.findByRole("link", { name: "Обзор" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Каталог" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Киоски" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "Интеграции" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Настройки" })).toBeNull();
});

it("renders an explicit forbidden page for manager-only direct integrations and settings URLs", async () => {
  const first = renderAccessRoute("/integrations", MANAGER_ACCESS);
  expect(await screen.findByText("Эта страница недоступна")).toBeDefined();
  first.unmount();

  renderAccessRoute("/settings", MANAGER_ACCESS);
  expect(await screen.findByText("Эта страница недоступна")).toBeDefined();
});

it("allows a manager to open the catalog directly", async () => {
  renderAccessRoute("/catalog", MANAGER_ACCESS);

  expect(await screen.findByRole("heading", { name: "Каталог продукции" })).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
});

it.each(["/catalog/new", "/catalog/p1/edit"])(
  "forbids the direct write route %s for a read-only operator",
  async (path) => {
    renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it("keeps the label library readable but blocks editor routes", async () => {
  renderAccessRoute("/labels", OPERATIONS_READ_ONLY);
  expect(await screen.findByRole("heading", { name: "Шаблоны этикеток" })).toBeDefined();
  cleanup();

  renderAccessRoute("/labels/new", OPERATIONS_READ_ONLY);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  cleanup();

  renderAccessRoute("/labels/template_1", OPERATIONS_READ_ONLY);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
});

it("shows integrations and settings navigation to administrators", async () => {
  renderAccessRoute("/", ADMIN_ACCESS);

  expect(await screen.findByRole("link", { name: "Интеграции" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Настройки" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Доступ в кабинет" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Открыть профиль Елена Ким" })).toBeDefined();
});

it("redirects legacy signed-in users to global profile completion and preserves the requested route", async () => {
  renderAccessRoute("/catalog", MANAGER_ACCESS, {
    firstName: null,
    lastName: null,
    middleName: null,
    hasAvatar: false,
  });

  expect(await screen.findByRole("heading", { name: "Мой профиль" })).toBeDefined();
  expect(screen.getByText("Заполните профиль")).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Каталог продукции" })).toBeNull();
});

it("hides Team from managers and forbids the direct route", async () => {
  renderAccessRoute("/team", MANAGER_ACCESS);

  expect(await screen.findByText("Эта страница недоступна")).toBeDefined();
  expect(screen.queryByRole("link", { name: "Команда" })).toBeNull();
});

it("allows administrators to open integrations and settings directly", async () => {
  const first = renderAccessRoute("/integrations", ADMIN_ACCESS);
  expect(await screen.findByRole("heading", { name: "Интеграции" })).toBeDefined();
  first.unmount();

  renderAccessRoute("/settings", ADMIN_ACCESS);
  expect(await screen.findByRole("heading", { name: "Настройки" })).toBeDefined();
});

it("uses synthetic capabilities rather than role names and skips the pickup badge request", async () => {
  const { requests } = renderAccessRoute("/integrations", INTEGRATIONS_ONLY_ACCESS);

  expect(await screen.findByRole("heading", { name: "Интеграции" })).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
  expect(requests.some((path) => path.includes("/api/pickup-orders"))).toBe(false);
});

it("forbids operational routes for a synthetic integrations-only grant", async () => {
  renderAccessRoute("/catalog", INTEGRATIONS_ONLY_ACCESS);

  expect(await screen.findByText("Эта страница недоступна")).toBeDefined();
  expect(screen.queryByRole("link", { name: "Каталог" })).toBeNull();
});
