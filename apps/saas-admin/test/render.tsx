import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { AppRoutes } from "../src/app.js";
import type { PlatformPrincipal } from "../src/auth/PlatformAuthBoundary.js";
import {
  AuthClientProvider,
  type AuthActionResult,
  type AuthClientLike,
  type PlatformSessionData,
} from "../src/auth/client.js";
import type { CatalogVersionDto } from "../src/pages/catalog/api.js";

export interface MutableAuthState {
  session: PlatformSessionData | null;
  sessionPending: boolean;
  sessionError: unknown;
  signInResult: AuthActionResult<{ twoFactorRedirect?: boolean }>;
  enrollment: { totpURI: string; backupCodes: string[] };
}

export function authState(overrides: Partial<MutableAuthState> = {}): MutableAuthState {
  return {
    session: null,
    sessionPending: false,
    sessionError: null,
    signInResult: { data: {}, error: null },
    enrollment: {
      totpURI: "otpauth://totp/Markiro%20Platform:user@example.invalid?secret=not-persisted",
      backupCodes: ["alpha-one", "bravo-two"],
    },
    ...overrides,
  };
}

export function readySession(twoFactorEnabled = true): PlatformSessionData {
  return {
    session: { id: "session-1" },
    user: {
      id: "user-1",
      email: "operator@example.invalid",
      name: "Operator",
      twoFactorEnabled,
    },
  };
}

export function fakeAuthClient(state: MutableAuthState): AuthClientLike {
  return {
    useSession: () => ({
      data: state.session,
      isPending: state.sessionPending,
      error: state.sessionError,
    }),
    signIn: {
      email: async () => state.signInResult,
    },
    signOut: async () => ({ data: { success: true }, error: null }),
    revokeOtherSessions: async () => ({ data: { status: true }, error: null }),
    twoFactor: {
      enable: async () => ({ data: state.enrollment, error: null }),
      verifyTotp: async () => {
        state.session = readySession(true);
        return { data: { token: "not-rendered" }, error: null };
      },
      verifyBackupCode: async () => {
        state.session = readySession(true);
        return { data: { user: state.session.user }, error: null };
      },
      disable: async () => {
        state.session = readySession(false);
        return { data: { status: true }, error: null };
      },
    },
  };
}

export function renderSaasApp({
  initialEntry = "/catalog",
  state = authState({ session: readySession() }),
  client = fakeAuthClient(state),
  extra,
}: {
  initialEntry?: string;
  state?: MutableAuthState;
  client?: AuthClientLike;
  extra?: ReactNode;
} = {}): RenderResult & { state: MutableAuthState; queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    state,
    queryClient,
    ...render(
      <ThemeProvider defaultTheme="light">
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <AuthClientProvider client={client}>
              <AppRoutes />
              {extra}
            </AuthClientProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    ),
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const ACCOUNTANT_ME = {
  userId: "user-1",
  role: "accountant",
  capabilities: [
    "tenants.read",
    "catalog.read",
    "catalog.write",
    "billing.read",
    "billing.write",
    "audit.read",
  ],
  twoFactorReady: true,
} satisfies PlatformPrincipal;

export const SUPPORT_ME = {
  userId: "user-1",
  role: "support",
  capabilities: ["tenants.read", "tenants.write", "catalog.read", "audit.read"],
  twoFactorReady: true,
} satisfies PlatformPrincipal;

export const DRAFT_PLAN = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  kind: "plan",
  version: 2,
  status: "draft",
  nameRu: "Базовый",
  nameEn: "Basic",
  descriptionRu: "Для одной площадки",
  descriptionEn: "For one site",
  unit: "month",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "15000.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedAt: null,
  publishedByPlatformUserId: null,
  plan: {
    maxLines: 2,
    maxStations: 3,
    maxKiosks: 1,
    maxCabinetUsers: 5,
    labelEditorEnabled: true,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: 14,
  },
} satisfies CatalogVersionDto;

export const PUBLISHED_PLAN = {
  ...DRAFT_PLAN,
  id: "31111111-1111-4111-8111-111111111111",
  version: 1,
  status: "published",
  publishedAt: "2026-08-09T08:00:00.000Z",
  publishedByPlatformUserId: "user-2",
} satisfies CatalogVersionDto;

export const ADDON = {
  id: "41111111-1111-4111-8111-111111111111",
  catalogItemId: "51111111-1111-4111-8111-111111111111",
  catalogItemCode: "addon-station",
  kind: "addon",
  version: 1,
  status: "published",
  nameRu: "Дополнительная станция",
  nameEn: "Extra station",
  descriptionRu: null,
  descriptionEn: null,
  unit: "station",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "2500.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedAt: "2026-08-09T08:00:00.000Z",
  publishedByPlatformUserId: "user-2",
  addon: { effects: [{ key: "stations", quotaIncrement: 1 }] },
} satisfies CatalogVersionDto;

export const SERVICE = {
  id: "61111111-1111-4111-8111-111111111111",
  catalogItemId: "71111111-1111-4111-8111-111111111111",
  catalogItemCode: "service-implementation",
  kind: "service",
  version: 1,
  status: "published",
  nameRu: "Внедрение",
  nameEn: "Implementation",
  descriptionRu: null,
  descriptionEn: null,
  unit: "project",
  billingMode: "one_time",
  billingPeriod: null,
  unitPrice: "50000.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedAt: "2026-08-09T08:00:00.000Z",
  publishedByPlatformUserId: "user-2",
  service: {},
} satisfies CatalogVersionDto;

export function installCatalogApi({
  me = ACCOUNTANT_ME,
  items = [DRAFT_PLAN, PUBLISHED_PLAN, ADDON, SERVICE],
  defaultDemoId = null,
}: {
  me?: PlatformPrincipal;
  items?: CatalogVersionDto[];
  defaultDemoId?: string | null;
} = {}) {
  let catalog: CatalogVersionDto[] = items.map((item) => structuredClone(item));
  let demoId = defaultDemoId;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/catalog/items") && (!init.method || init.method === "GET")) {
        return jsonResponse(200, { items: catalog });
      }
      if (
        url.endsWith("/api/platform/settings/demo-plan") &&
        (!init.method || init.method === "GET")
      ) {
        return jsonResponse(200, { catalogVersionId: demoId });
      }
      if (url.endsWith("/api/platform/settings/demo-plan") && init.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { catalogVersionId: string };
        demoId = body.catalogVersionId;
        return jsonResponse(200, { catalogVersionId: demoId });
      }
      const match = url.match(
        /\/api\/platform\/catalog\/items\/([^/]+)\/versions\/([^/]+)(\/publish)?$/,
      );
      if (match?.[3] === "/publish" && init.method === "POST") {
        catalog = catalog.map((item) =>
          item.id === match[2]
            ? { ...item, status: "published", publishedAt: "2026-08-09T09:00:00.000Z" }
            : item,
        );
        return jsonResponse(
          200,
          catalog.find((item) => item.id === match[2]),
        );
      }
      if (match && init.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        catalog = catalog.map((item) => (item.id === match[2] ? { ...item, ...body } : item));
        return jsonResponse(
          200,
          catalog.find((item) => item.id === match[2]),
        );
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }),
  );

  return { items: () => catalog, defaultDemoId: () => demoId };
}
