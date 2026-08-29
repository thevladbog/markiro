import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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

const ID = {
  inventory: "11111111-1111-4111-8111-111111111111",
  product: "22222222-2222-4222-8222-222222222222",
  line: "33333333-3333-4333-8333-333333333333",
  template: "44444444-4444-4444-8444-444444444444",
} as const;

const SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};
const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka" }];
const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const BASE_INVENTORY = {
  id: ID.inventory,
  number: "IVN-26-0042",
  status: "preparing",
  mode: "repack",
  productId: ID.product,
  gtin14: "04680089900383",
  productName: "Пиво светлое 0,45 л",
  lineId: ID.line,
  lineName: "Упаковка А",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  boxLabelTemplateId: ID.template,
  boxLabelTemplate: { id: ID.template, name: "Короб 20 бутылок" },
  activeSnapshotId: null,
  resultRevision: 0,
  createdAt: "2026-08-26T09:00:00.000Z",
  updatedAt: "2026-08-26T09:05:00.000Z",
};
const BLOCKERS = {
  activeParticipantCount: 0,
  pendingEventCount: 0,
  participantOpenBoxCount: 0,
  openRepackBoxCount: 0,
  unresolvedPrintBoxCount: 0,
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_INVENTORY,
    blockers: BLOCKERS,
    imports: [],
    activeSnapshot: null,
    ...overrides,
  };
}

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

function shellDependency(url: string): Response | null {
  if (url.endsWith("/api/profile")) {
    return response({ firstName: "Елена", lastName: "Ким", middleName: null, hasAvatar: false });
  }
  if (url.includes("/api/pickup-orders")) return response({ items: [] });
  return null;
}

interface ChzExportRunFixture {
  status: string;
  state: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  importId: string | null;
  orderedAt: string | null;
  completedAt: string | null;
}

interface ChzExportStateFixture {
  available: boolean;
  blockedBy: string[];
  runs: ChzExportRunFixture[];
}

function run(
  status: string,
  state: string,
  overrides: Partial<ChzExportRunFixture> = {},
): ChzExportRunFixture {
  return {
    status,
    state,
    attempts: 1,
    errorCode: null,
    errorMessage: null,
    importId: null,
    orderedAt: "2026-08-26T09:01:00.000Z",
    completedAt: state === "imported" ? "2026-08-26T09:05:00.000Z" : null,
    ...overrides,
  };
}

let currentChzState: ChzExportStateFixture = { available: false, blockedBy: [], runs: [] };
let orderCalls: Array<Record<string, never>> = [];
let retryCalls: Array<{ status: string }> = [];

function stubChzExports(initial: ChzExportStateFixture): void {
  currentChzState = structuredClone(initial);
}

function renderPreparation() {
  orderCalls = [];
  retryCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/access/me")) return response(ACCESS);
      const dependency = shellDependency(url);
      if (dependency) return dependency;
      if (url === `/api/inventories/${ID.inventory}` && !init?.method) {
        return response(detail());
      }
      if (url === `/api/inventories/${ID.inventory}/chz-exports` && (!init || !init.method)) {
        return response(currentChzState);
      }
      if (url === `/api/inventories/${ID.inventory}/chz-exports` && init?.method === "POST") {
        orderCalls.push({});
        currentChzState = {
          available: true,
          blockedBy: [],
          runs: [run("EMITTED", "ordered")],
        };
        return response(currentChzState, 201);
      }
      if (
        url === `/api/inventories/${ID.inventory}/chz-exports/retry` &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as { status: string };
        retryCalls.push({ status: body.status });
        currentChzState = {
          ...currentChzState,
          runs: currentChzState.runs.map((item) =>
            item.status === body.status
              ? { ...item, state: "ordered", attempts: item.attempts + 1, errorMessage: null }
              : item,
          ),
        };
        return response(currentChzState);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [`/inventory/${ID.inventory}`],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={authClient()}>
          <RouterProvider router={router} />
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

it("disables ordering and names every blocker", async () => {
  stubChzExports({ available: false, blockedBy: ["INN_MISSING", "TOKEN_UNAVAILABLE"], runs: [] });
  renderPreparation();
  const button = await screen.findByRole("button", { name: "Заказать из Честного Знака" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/ИНН организации/)).toBeDefined();
  expect(screen.getByText(/токен/i)).toBeDefined();
});

it("orders once and shows per-status progress", async () => {
  const user = userEvent.setup();
  stubChzExports({ available: true, blockedBy: [], runs: [] });
  renderPreparation();
  await user.click(await screen.findByRole("button", { name: "Заказать из Честного Знака" }));
  await waitFor(() => expect(orderCalls).toHaveLength(1));
  expect(await screen.findByText("Заказано")).toBeDefined();
});

it("retries only the failed status", async () => {
  const user = userEvent.setup();
  stubChzExports({
    available: true,
    blockedBy: [],
    runs: [
      run("EMITTED", "imported"),
      run("RETIRED", "failed", { errorMessage: "нет действующего договора" }),
    ],
  });
  renderPreparation();
  expect(await screen.findByText("нет действующего договора")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(retryCalls).toEqual([{ status: "RETIRED" }]));
});

it("leaves manual upload available regardless of the export state", async () => {
  stubChzExports({ available: false, blockedBy: ["AGENT_NOT_PAIRED"], runs: [] });
  renderPreparation();
  // Manual upload is the fallback and the path for tenants with no agent.
  expect((await screen.findAllByTestId("inventory-upload-slot")).length).toBe(6);
});
