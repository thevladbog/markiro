import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
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

const SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};
const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka" }];
const READ_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};
const WRITE_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const INVENTORY = {
  id: "11111111-1111-4111-8111-111111111111",
  number: "ИНВ-00042",
  status: "draft",
  mode: "check",
  productId: "22222222-2222-4222-8222-222222222222",
  gtin14: "04680089900383",
  productName: "Пиво светлое 0,45 л",
  lineId: "33333333-3333-4333-8333-333333333333",
  lineName: "Упаковка А",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  boxLabelTemplateId: null,
  boxLabelTemplate: null,
  activeSnapshotId: null,
  resultRevision: 0,
  createdAt: "2026-08-26T09:00:00.000Z",
  updatedAt: "2026-08-26T09:00:00.000Z",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authClient(): AuthClientLike {
  return {
    useSession: () => ({ data: SESSION, isPending: false, error: null }),
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
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
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
      if (url === "/api/inventories") return response({ items: [INVENTORY] });
      if (url === `/api/inventories/${INVENTORY.id}`) {
        return response({
          ...INVENTORY,
          blockers: {
            activeParticipantCount: 0,
            pendingEventCount: 0,
            participantOpenBoxCount: 0,
            openRepackBoxCount: 0,
            unresolvedPrintBoxCount: 0,
          },
          imports: [],
          activeSnapshot: null,
        });
      }
      if (url === "/api/products" || url === "/api/lines" || url === "/api/label-templates") {
        return response({ items: [] });
      }
      if (url === "/api/shifts/planning-config") {
        return response({ defaultBoxLabelTemplateId: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={authClient()}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { requests, router };
}

function routePaths(routes: RouteObject[], parent = ""): string[] {
  return routes.flatMap((route) => {
    const own = route.path
      ? route.path.startsWith("/")
        ? route.path
        : `${parent}/${route.path}`.replace(/\/+/g, "/")
      : parent;
    return [own, ...routePaths(route.children ?? [], own)];
  });
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps inventory list/detail readable while exposing write controls only to writers", async () => {
  const reader = renderRoute("/inventory", READ_ACCESS);
  expect(await screen.findByRole("heading", { name: "Инвентаризации" })).toBeDefined();
  expect(await screen.findByRole("link", { name: "ИНВ-00042" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Инвентаризации" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Создать инвентаризацию" })).toBeNull();
  expect(screen.queryByText(INVENTORY.updatedAt)).toBeNull();
  expect(await screen.findByText(/\d{2}:\d{2}/)).toBeDefined();
  reader.router.dispose();
  cleanup();

  renderRoute("/inventory", WRITE_ACCESS);
  expect(await screen.findByRole("button", { name: "Создать инвентаризацию" })).toBeDefined();
});

it("denies direct create to readers before loading form dependencies", async () => {
  const { requests } = renderRoute("/inventory/new", READ_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(requests).not.toContain("/api/products");
  expect(requests).not.toContain("/api/lines");
});

it("keeps create and detail as distinct tenant-admin nested routes", async () => {
  const create = renderRoute("/inventory/new", WRITE_ACCESS);
  expect(await screen.findByRole("heading", { name: "Новая инвентаризация" })).toBeDefined();
  create.router.dispose();
  cleanup();

  const detail = renderRoute(`/inventory/${INVENTORY.id}`, READ_ACCESS);
  expect(await screen.findByRole("heading", { name: "ИНВ-00042" })).toBeDefined();
  expect(detail.requests).toContain(`/api/inventories/${INVENTORY.id}`);
});

it("does not register inventory preparation in the SaaS-admin router", async () => {
  const { appRoutes: saasAdminRoutes } = await import("../../saas-admin/src/app.js");
  expect(routePaths(saasAdminRoutes).some((path) => path.startsWith("/inventory"))).toBe(false);
});
