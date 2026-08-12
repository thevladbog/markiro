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

const JANE = {
  id: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  status: "active",
  badges: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const KIOSK = {
  id: "k1",
  name: "Касса у входа",
  location: "Зал 1",
  dayLimitPerEmployee: 5,
  showPrices: true,
  status: "active",
  lastSeenAt: null,
  enrolled: false,
  productIds: [],
  createdAt: "2026-08-06T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
      if (path.endsWith("/api/pickup-reasons")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/counterparties")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/employees")) return jsonResponse(200, { items: [JANE] });
      if (path.endsWith("/api/kiosks")) return jsonResponse(200, { items: [KIOSK] });
      if (path.endsWith("/api/operators")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/label-templates")) return jsonResponse(200, { items: [] });
      if (path.includes("/api/devices"))
        return jsonResponse(200, { items: [], page: 1, pageSize: 8, total: 0 });
      if (path.startsWith("/api/shifts")) return jsonResponse(200, { items: [] });
      if (path.endsWith("/api/lines")) return jsonResponse(200, { items: [] });
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
  expect(screen.getByRole("link", { name: "Устройства" })).toBeDefined();
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

it("allows operations readers to open production lines and forbids users without read access", async () => {
  const reader = renderAccessRoute("/lines", OPERATIONS_READ_ONLY);
  expect(await screen.findByRole("heading", { name: "Производственные линии" })).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
  reader.unmount();

  renderAccessRoute("/lines", INTEGRATIONS_ONLY_ACCESS);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
});

it("keeps kiosk management separate from the unified devices page", async () => {
  const { requests } = renderAccessRoute("/kiosks", MANAGER_ACCESS);

  expect(await screen.findByRole("heading", { name: "Киоски" })).toBeDefined();
  await expect.poll(() => requests).toContain("/api/kiosks");
  expect(requests.some((request) => request.startsWith("/api/devices"))).toBe(false);
});

it.each(["/catalog/new", "/catalog/p1/edit"])(
  "forbids the direct write route %s for a read-only operator",
  async (path) => {
    renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it("allows a read-only operator to open write-off reasons directly", async () => {
  renderAccessRoute("/kiosks/reasons", OPERATIONS_READ_ONLY);

  expect(await screen.findByRole("heading", { name: "Киоски" })).toBeDefined();
  expect(await screen.findByText("Причины списания не добавлены")).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
  expect(screen.queryByRole("button", { name: "Добавить причину" })).toBeNull();
});

it.each(["/counterparties/new", "/counterparties/p1/edit"])(
  "forbids the direct counterparty write route %s for a read-only operator",
  async (path) => {
    renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it.each(["/shifts/new", "/shifts/s1/edit"])(
  "forbids the direct shift write route %s for a read-only operator",
  async (path) => {
    renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it.each(["/lines/new", "/lines/line-1/edit"])(
  "forbids the direct line write route %s for a read-only operator",
  async (path) => {
    renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it.each(["/employees/new", "/employees/1/edit"])(
  "forbids the direct employee write route %s for a read-only operator",
  async (path) => {
    const { requests } = renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requests.some((request) => request.endsWith("/api/operators"))).toBe(false);
  },
);

it.each(["/kiosks/new", "/kiosks/k1/edit"])(
  "forbids the direct kiosk write route %s for a read-only operator",
  async (path) => {
    renderAccessRoute(path, OPERATIONS_READ_ONLY);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it.each([
  ["read-only operator", OPERATIONS_READ_ONLY],
  ["operations writer", MANAGER_ACCESS],
])("forbids the direct kiosk pairing route for a %s", async (_label, access) => {
  const { requests } = renderAccessRoute("/kiosks/k1/pair", access);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests.some((request) => request.includes("/pairing-code"))).toBe(false);
});

it("opens the direct kiosk pairing route for a credential manager without minting", async () => {
  const { requests } = renderAccessRoute("/kiosks/k1/pair", ADMIN_ACCESS);

  expect(await screen.findByRole("dialog", { name: "Привязка киоска" })).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
  expect(requests.some((request) => request.includes("/pairing-code"))).toBe(false);
});

it.each([
  ["/catalog/new", "Новый продукт"],
  ["/catalog/p1/edit", "Изменить продукт"],
  ["/employees/new", "Новый сотрудник"],
  ["/employees/1/edit", "Изменить сотрудника"],
  ["/kiosks/new", "Новый киоск"],
  ["/kiosks/k1/edit", "Изменить киоск"],
  ["/lines/new", "Новая линия"],
])("opens the direct write route %s for a write-capable operator", async (path, title) => {
  renderAccessRoute(path, MANAGER_ACCESS);

  expect(await screen.findByRole("dialog", { name: title })).toBeDefined();
  expect(screen.queryByTestId("forbidden-page")).toBeNull();
});

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
