import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { appRoutes } from "../src/app.js";
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
  verifyTotpResult: AuthActionResult<unknown> | null;
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
    verifyTotpResult: null,
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

export function fakeAuthClient(
  state: MutableAuthState,
  { onSignOut }: { onSignOut?: () => void } = {},
): AuthClientLike {
  return {
    useSession: () => ({
      data: state.session,
      isPending: state.sessionPending,
      error: state.sessionError,
    }),
    signIn: {
      email: async () => state.signInResult,
    },
    signOut: async () => {
      onSignOut?.();
      return { data: { success: true }, error: null };
    },
    revokeOtherSessions: async () => ({ data: { status: true }, error: null }),
    twoFactor: {
      enable: async () => ({ data: state.enrollment, error: null }),
      verifyTotp: async () => {
        if (state.verifyTotpResult) return state.verifyTotpResult;
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
  const router = createMemoryRouter(appRoutes, { initialEntries: [initialEntry] });
  return {
    state,
    queryClient,
    ...render(
      <ThemeProvider defaultTheme="light">
        <QueryClientProvider client={queryClient}>
          <AuthClientProvider client={client}>
            <RouterProvider router={router} />
            {extra}
          </AuthClientProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    ),
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const normalizedBody =
    status >= 400 &&
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    typeof body.code === "string"
      ? {
          message: "Platform request failed",
          requestId: "11111111-1111-4111-8111-111111111111",
          ...body,
        }
      : body;
  return new Response(JSON.stringify(normalizedBody), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

export const PLATFORM_ADMIN_ME = {
  userId: "user-1",
  role: "platform_admin",
  capabilities: [
    "tenants.read",
    "tenants.write",
    "catalog.read",
    "catalog.write",
    "billing.read",
    "billing.write",
    "platformTeam.write",
    "audit.read",
  ],
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

interface CatalogPatchCall {
  method: "PATCH";
  path: string;
  body: unknown;
}

interface CatalogCreateCall {
  itemCode: string;
  body: unknown;
}

export function installCatalogApi({
  me = ACCOUNTANT_ME,
  items = [DRAFT_PLAN, PUBLISHED_PLAN, ADDON, SERVICE],
  defaultDemoId = null,
  saveStatuses = [],
  defaultStatuses = [],
  createResponses = [],
  archiveStatuses = [],
  catalogStatus = 200,
}: {
  me?: PlatformPrincipal;
  items?: CatalogVersionDto[];
  defaultDemoId?: string | null;
  saveStatuses?: number[];
  defaultStatuses?: number[];
  createResponses?: number[];
  archiveStatuses?: number[];
  catalogStatus?: number;
} = {}) {
  let catalog: CatalogVersionDto[] = items.map((item) => structuredClone(item));
  let demoId = defaultDemoId;
  const patchCalls: CatalogPatchCall[] = [];
  const createCalls: CatalogCreateCall[] = [];
  let createSequence = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.endsWith("/api/platform/catalog/items") && (!init.method || init.method === "GET")) {
        if (catalogStatus !== 200) {
          return jsonResponse(catalogStatus, { code: "catalog_unavailable" });
        }
        return jsonResponse(200, { items: catalog });
      }
      if (
        url.endsWith("/api/platform/settings/demo-plan") &&
        (!init.method || init.method === "GET")
      ) {
        return jsonResponse(200, { catalogVersionId: demoId });
      }
      if (url.endsWith("/api/platform/settings/demo-plan") && init.method === "PATCH") {
        const status = defaultStatuses.shift() ?? 200;
        if (status !== 200) {
          return jsonResponse(status, { code: "catalog_version_conflict" });
        }
        const body = JSON.parse(String(init.body)) as { catalogVersionId: string };
        demoId = body.catalogVersionId;
        return jsonResponse(200, { catalogVersionId: demoId });
      }
      const createMatch = url.match(/\/api\/platform\/catalog\/items\/([^/]+)\/versions$/);
      if (createMatch && init.method === "POST") {
        const status = createResponses.shift() ?? 201;
        if (status !== 201) return jsonResponse(status, { code: "catalog_item_conflict" });
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createCalls.push({ itemCode: createMatch[1]!, body: structuredClone(body) });
        const source = catalog.find((item) => item.catalogItemCode === createMatch[1]);
        const nextVersion =
          Math.max(
            0,
            ...catalog
              .filter((item) => item.catalogItemCode === createMatch[1])
              .map((item) => item.version),
          ) + 1;
        createSequence += 1;
        const created = {
          ...structuredClone(source ?? DRAFT_PLAN),
          ...body,
          id: `71111111-1111-4111-8111-${String(createSequence).padStart(12, "0")}`,
          catalogItemId: source?.catalogItemId ?? "81111111-1111-4111-8111-111111111111",
          catalogItemCode: createMatch[1],
          kind: body.plan ? "plan" : body.addon ? "addon" : "service",
          version: nextVersion,
          status: "draft",
          publishedAt: null,
          publishedByPlatformUserId: null,
        } as CatalogVersionDto;
        catalog = [...catalog, created];
        return jsonResponse(201, created);
      }
      const archiveMatch = url.match(/\/api\/platform\/catalog\/items\/([^/]+)\/archive$/);
      if (archiveMatch && init.method === "POST") {
        const status = archiveStatuses.shift() ?? 200;
        if (status !== 200)
          return jsonResponse(status, { code: "catalog_item_versions_not_retired" });
        catalog = catalog.filter((item) => item.catalogItemCode !== archiveMatch[1]);
        return jsonResponse(200, { status: "archived" });
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
        patchCalls.push({ method: "PATCH", path: url, body });
        const status = saveStatuses.shift() ?? 200;
        if (status !== 200) {
          return jsonResponse(status, { code: "catalog_version_conflict" });
        }
        catalog = catalog.map((item) => (item.id === match[2] ? { ...item, ...body } : item));
        return jsonResponse(
          200,
          catalog.find((item) => item.id === match[2]),
        );
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }),
  );

  return {
    items: () => catalog,
    defaultDemoId: () => demoId,
    patchCalls: () => structuredClone(patchCalls),
    createCalls: () => structuredClone(createCalls),
  };
}

export const TENANT_ID = "81111111-1111-4111-8111-111111111111";

const SCHEDULED_PLAN = {
  ...structuredClone(PUBLISHED_PLAN),
  id: "91111111-1111-4111-8111-111111111111",
  catalogItemId: "a1111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-production",
  version: 3,
  nameRu: "Производственный",
  nameEn: "Production",
  unitPrice: "45000.00",
  plan: {
    maxLines: 10,
    maxStations: 12,
    maxKiosks: 4,
    maxCabinetUsers: 20,
    labelEditorEnabled: true,
    publicApiEnabled: true,
    palletsEnabled: true,
    demoDurationDays: null,
  },
} satisfies CatalogVersionDto;

export const TENANT_LIST_ITEM = {
  id: TENANT_ID,
  name: "Первый завод",
  slug: "first-factory",
  createdAt: "2026-08-09T08:00:00.000Z",
  subscriptionStatus: "trial",
  subscription: {
    id: "b1111111-1111-4111-8111-111111111111",
    status: "trial",
    startsAt: "2026-08-08T08:00:00.000Z",
    endsAt: "2026-08-24T08:00:00.000Z",
    planVersion: {
      id: PUBLISHED_PLAN.id,
      version: 1,
      nameRu: "Базовый",
      nameEn: "Basic",
      unitPrice: "15000.00",
    },
  },
};

export const TENANT_DETAIL = {
  tenant: {
    id: TENANT_ID,
    name: "Первый завод",
    slug: "first-factory",
    createdAt: "2026-08-09T08:00:00.000Z",
  },
  subscriptionStatus: "trial",
  ownerActivation: {
    ownerUserId: "owner-user-1",
    ownerEmail: "owner@example.com",
    emailVerified: true,
    deliveryId: "c1111111-1111-4111-8111-111111111111",
    status: "sent",
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:01:00.000Z",
    terminalAt: "2026-08-09T08:01:00.000Z",
  },
  currentSubscription: {
    id: "b1111111-1111-4111-8111-111111111111",
    tenantId: TENANT_ID,
    planVersionId: PUBLISHED_PLAN.id,
    status: "trial",
    startsAt: "2026-08-08T08:00:00.000Z",
    endsAt: "2026-08-24T08:00:00.000Z",
    source: "demo",
    createdByPlatformUserId: null,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-10T08:00:00.000Z",
    planVersion: {
      id: PUBLISHED_PLAN.id,
      catalogItemId: PUBLISHED_PLAN.catalogItemId,
      catalogItemCode: "plan-basic",
      kind: "plan",
      version: 1,
      status: "published",
      nameRu: "Базовый",
      nameEn: "Basic",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "15000.00",
      vatRateBps: 2000,
      vatIncluded: true,
      entitlements: {
        catalogVersionId: PUBLISHED_PLAN.id,
        catalogKind: "plan",
        maxLines: 2,
        maxStations: 3,
        maxKiosks: 1,
        maxCabinetUsers: 5,
        labelEditorEnabled: true,
        publicApiEnabled: false,
        palletsEnabled: false,
        demoDurationDays: 14,
      },
    },
  },
  scheduledSubscription: {
    id: "d1111111-1111-4111-8111-111111111111",
    tenantId: TENANT_ID,
    planVersionId: SCHEDULED_PLAN.id,
    status: "scheduled",
    startsAt: "2026-08-24T08:00:00.000Z",
    endsAt: null,
    source: "manual",
    createdByPlatformUserId: "user-1",
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T08:00:00.000Z",
    planVersion: {
      id: SCHEDULED_PLAN.id,
      catalogItemId: SCHEDULED_PLAN.catalogItemId,
      catalogItemCode: "plan-production",
      kind: "plan",
      version: 3,
      status: "published",
      nameRu: "Производственный",
      nameEn: "Production",
      unit: "month",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "45000.00",
      vatRateBps: 2000,
      vatIncluded: true,
      entitlements: {
        catalogVersionId: SCHEDULED_PLAN.id,
        catalogKind: "plan",
        maxLines: 10,
        maxStations: 12,
        maxKiosks: 4,
        maxCabinetUsers: 20,
        labelEditorEnabled: true,
        publicApiEnabled: true,
        palletsEnabled: true,
        demoDurationDays: null,
      },
    },
  },
  activeAddons: [
    {
      id: "e1111111-1111-4111-8111-111111111111",
      subscriptionId: "b1111111-1111-4111-8111-111111111111",
      addonVersionId: ADDON.id,
      quantity: 1,
      startsAt: "2026-08-11T08:00:00.000Z",
      endsAt: "2026-08-24T08:00:00.000Z",
      status: "active",
      source: "manual",
      addonVersion: {
        id: ADDON.id,
        catalogItemId: ADDON.catalogItemId,
        catalogItemCode: "addon-station",
        kind: "addon",
        version: 1,
        status: "published",
        nameRu: "Дополнительная станция",
        nameEn: "Extra station",
        unit: "station",
        billingMode: "recurring",
        billingPeriod: "month",
        unitPrice: "2500.00",
        vatRateBps: 2000,
        vatIncluded: true,
        effects: [{ entitlementKey: "stations", quotaIncrement: 1, featureEnabled: false }],
      },
    },
  ],
  scheduledAddons: [
    {
      id: "f1111111-1111-4111-8111-111111111111",
      subscriptionId: "d1111111-1111-4111-8111-111111111111",
      addonVersionId: ADDON.id,
      quantity: 2,
      startsAt: "2026-08-24T08:00:00.000Z",
      endsAt: null,
      status: "scheduled",
      source: "manual",
      addonVersion: {
        id: ADDON.id,
        catalogItemId: ADDON.catalogItemId,
        catalogItemCode: "addon-station",
        kind: "addon",
        version: 1,
        status: "published",
        nameRu: "Дополнительная станция",
        nameEn: "Extra station",
        unit: "station",
        billingMode: "recurring",
        billingPeriod: "month",
        unitPrice: "2500.00",
        vatRateBps: 2000,
        vatIncluded: true,
        effects: [{ entitlementKey: "stations", quotaIncrement: 1, featureEnabled: false }],
      },
    },
  ],
  usage: { cabinetUsers: 5, kiosks: 1, lines: 3, stations: 5 },
  events: [
    {
      id: "12111111-1111-4111-8111-111111111111",
      subscriptionId: "d1111111-1111-4111-8111-111111111111",
      eventKind: "plan.scheduled",
      effectiveAt: "2026-08-24T08:00:00.000Z",
      source: "platform_manual",
      reason: "Согласованный переход",
      before: { status: "trial" },
      after: { status: "scheduled" },
      createdAt: "2026-08-11T08:00:00.000Z",
    },
    {
      id: "13111111-1111-4111-8111-111111111111",
      subscriptionId: "b1111111-1111-4111-8111-111111111111",
      eventKind: "demo.activated",
      effectiveAt: "2026-08-10T08:00:00.000Z",
      source: "tenant_owner_activation",
      reason: null,
      before: { status: "pending_activation" },
      after: { status: "trial" },
      createdAt: "2026-08-10T08:00:00.000Z",
    },
  ],
};

interface TenantMutationCall {
  method: string;
  path: string;
  body: unknown;
}

export function installTenantApi({
  me = PLATFORM_ADMIN_ME,
  items = [TENANT_LIST_ITEM],
  detail = TENANT_DETAIL,
  listStatus = 200,
  total = items.length,
  createResponses = [],
  renewResponses = [],
  assignmentResponses = [],
  detailResponses = [],
  catalogResponse = { items: [PUBLISHED_PLAN, SCHEDULED_PLAN, ADDON] },
  renewHandler,
}: {
  me?: PlatformPrincipal;
  items?: Array<Record<string, unknown>>;
  detail?: Record<string, unknown>;
  listStatus?: number;
  total?: number;
  createResponses?: Array<{ status: number; code?: string }>;
  renewResponses?: Array<{ status: number; code?: string }>;
  assignmentResponses?: Array<{ status: number; code?: string }>;
  detailResponses?: Array<Record<string, unknown>>;
  catalogResponse?: unknown;
  renewHandler?: () => Promise<Response>;
} = {}) {
  const mutationCalls: TenantMutationCall[] = [];
  let detailRequestCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, me);
      if (url.includes("/api/platform/tenants?") && method === "GET") {
        return listStatus === 200
          ? jsonResponse(200, { items, page: 1, limit: 50, total })
          : jsonResponse(listStatus, { code: "tenant_list_unavailable" });
      }
      if (url.endsWith("/api/platform/tenants") && method === "POST") {
        const body = JSON.parse(String(init.body));
        mutationCalls.push({ method, path: url, body });
        const response = createResponses.shift() ?? { status: 201 };
        if (response.status !== 201) {
          return jsonResponse(response.status, { code: response.code ?? "tenant_conflict" });
        }
        return jsonResponse(201, {
          tenantId: TENANT_ID,
          userId: "owner-user-1",
          memberId: "member-1",
          deliveryId: "c1111111-1111-4111-8111-111111111111",
        });
      }
      if (url.endsWith(`/api/platform/tenants/${TENANT_ID}`) && method === "GET") {
        const response = detailResponses[detailRequestCount] ?? detail;
        detailRequestCount += 1;
        return jsonResponse(200, response);
      }
      if (
        url.endsWith(`/api/platform/tenants/${TENANT_ID}/owner-activation/renew`) &&
        method === "POST"
      ) {
        mutationCalls.push({ method, path: url, body: JSON.parse(String(init.body)) });
        if (renewHandler) return renewHandler();
        const response = renewResponses.shift() ?? { status: 200 };
        return response.status === 200
          ? jsonResponse(200, { deliveryId: "14111111-1111-4111-8111-111111111111" })
          : jsonResponse(response.status, {
              code: response.code ?? "activation_delivery_sending",
            });
      }
      if (
        (url.endsWith(`/api/platform/tenants/${TENANT_ID}/subscription/plan`) ||
          url.endsWith(`/api/platform/tenants/${TENANT_ID}/subscription/addons`)) &&
        method === "POST"
      ) {
        const body = JSON.parse(String(init.body));
        mutationCalls.push({ method, path: url, body });
        const response = assignmentResponses.shift() ?? { status: 201 };
        if (response.status !== 201) {
          return jsonResponse(response.status, {
            code: response.code ?? "subscription_schedule_exists",
          });
        }
        const startsAt =
          body.activationPolicy === "after_current"
            ? "2026-08-24T08:00:00.000Z"
            : "2026-08-12T08:00:00.000Z";
        if (url.endsWith("/subscription/plan")) {
          return jsonResponse(201, {
            id: "15111111-1111-4111-8111-111111111111",
            tenantId: TENANT_ID,
            planVersionId: body.catalogVersionId,
            status: body.activationPolicy === "after_current" ? "scheduled" : "active",
            startsAt,
            endsAt: body.endsAt ?? null,
            source: "manual",
          });
        }
        return jsonResponse(201, {
          id: "15111111-1111-4111-8111-111111111111",
          tenantId: TENANT_ID,
          subscriptionId:
            body.activationPolicy === "after_current"
              ? "d1111111-1111-4111-8111-111111111111"
              : "b1111111-1111-4111-8111-111111111111",
          addonVersionId: body.catalogVersionId,
          quantity: body.quantity,
          startsAt,
          endsAt: body.endsAt ?? null,
          status: body.activationPolicy === "after_current" ? "scheduled" : "active",
          source: "manual",
        });
      }
      if (url.endsWith("/api/platform/catalog/items") && method === "GET") {
        return jsonResponse(200, catalogResponse, {
          "x-request-id": "11111111-1111-4111-8111-111111111111",
          "x-markiro-release-sha": "test-release-sha",
        });
      }
      if (url.endsWith("/api/platform/settings/demo-plan") && method === "GET") {
        return jsonResponse(200, { catalogVersionId: PUBLISHED_PLAN.id });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return {
    mutationCalls: () => structuredClone(mutationCalls),
    detailRequestCount: () => detailRequestCount,
  };
}
