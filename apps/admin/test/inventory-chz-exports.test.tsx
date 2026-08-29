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
      if (url === `/api/inventories/${ID.inventory}/chz-exports/retry` && init?.method === "POST") {
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
  vi.useRealTimers();
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

it("falls back to the error code when a failed run has no message", async () => {
  stubChzExports({
    available: true,
    blockedBy: [],
    runs: [run("RETIRED", "failed", { errorCode: "TIMEOUT", errorMessage: null })],
  });
  renderPreparation();
  expect(await screen.findByText("Код ошибки: TIMEOUT")).toBeDefined();
});

it("leaves manual upload available regardless of the export state", async () => {
  stubChzExports({ available: false, blockedBy: ["AGENT_NOT_PAIRED"], runs: [] });
  renderPreparation();
  // Manual upload is the fallback and the path for tenants with no agent.
  // Querying the FileDropZone itself (by its per-status accessible name)
  // means this fails if the drop zone is ever made conditional — unlike
  // counting the always-rendered outer <section data-testid="inventory-upload-slot">.
  expect((await screen.findAllByRole("button", { name: /Выбрать файл/ })).length).toBe(6);
});

it("translates a known safe error code into operator guidance instead of the raw code", async () => {
  stubChzExports({
    available: true,
    blockedBy: [],
    runs: [run("RETIRED", "failed", { errorCode: "CHZ_TASK_TIMED_OUT", errorMessage: null })],
  });
  renderPreparation();
  expect(
    await screen.findByText(/Честный Знак не подготовил отчёт за отведённое время/),
  ).toBeDefined();
  expect(screen.queryByText(/Код ошибки: CHZ_TASK_TIMED_OUT/)).toBeNull();
});

it("hides retry and points to manual upload once creation attempts are exhausted", async () => {
  stubChzExports({
    available: true,
    blockedBy: [],
    runs: [run("RETIRED", "failed", { errorCode: "CHZ_CREATE_ATTEMPTS_EXHAUSTED", attempts: 10 })],
  });
  renderPreparation();
  expect(await screen.findByText(/Достигнут предел попыток заказа этого статуса/)).toBeDefined();
  // The button would only be reset to `queued` and failed again on the very
  // next worker pass -- see ChzExportsService.retry's CHZ_EXPORT_RETRY_EXHAUSTED.
  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
});

function importFixture(status: string): Record<string, unknown> {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    declaredStatus: status,
    parsedStatus: status,
    result: "succeeded",
    rowCount: 1,
    errorCount: 0,
    duplicateCount: 0,
    sha256: "0".repeat(64),
    diagnostics: [],
    fileName: `${status.toLowerCase()}.zip`,
    createdAt: "2026-08-26T09:05:00.000Z",
  };
}

it("invalidates the inventory detail query once a poll reports a new imported run", async () => {
  // Regression for the finished-export-never-refills-the-slot bug: nothing
  // used to invalidate `useInventory` when a run flipped to `imported`
  // outside a mutation, so the six upload slots (rendered from
  // `inventory.imports`) stayed empty under a green "Импортировано" badge
  // until the operator reloaded. This stub is extended (unlike the fixed
  // `imports: []` the other tests use) so the detail response can actually
  // reflect the import once it exists.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let detailFetchCount = 0;
  let pollCount = 0;
  let chzState: ChzExportStateFixture = {
    available: true,
    blockedBy: [],
    runs: [run("EMITTED", "ordered")],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/access/me")) return response(ACCESS);
      const dependency = shellDependency(url);
      if (dependency) return dependency;
      if (url === `/api/inventories/${ID.inventory}` && !init?.method) {
        detailFetchCount += 1;
        const imports = chzState.runs
          .filter((item) => item.state === "imported")
          .map((item) => importFixture(item.status));
        return response(detail({ imports }));
      }
      if (url === `/api/inventories/${ID.inventory}/chz-exports` && (!init || !init.method)) {
        pollCount += 1;
        if (pollCount === 2) {
          chzState = { ...chzState, runs: [run("EMITTED", "imported")] };
        }
        return response(chzState);
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

  expect(await screen.findByText("Заказано")).toBeDefined();
  await waitFor(() => expect(detailFetchCount).toBe(1));

  // The worker's own cadence is 30s (CHZ_EXPORT_POLL_INTERVAL_SECONDS in
  // apps/api/src/jobs/jobs.module.ts); the panel polls at 10s.
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(pollCount).toBe(2));
  await waitFor(() => expect(screen.getByText("Импортировано")).toBeDefined());
  // The detail query must have been invalidated and refetched -- not just
  // the chz-exports poll landing.
  await waitFor(() => expect(detailFetchCount).toBeGreaterThanOrEqual(2));
});
