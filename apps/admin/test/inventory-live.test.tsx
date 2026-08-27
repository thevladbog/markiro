// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const RESULT_ID = "55555555-5555-4555-8555-555555555555";
const SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};
const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka" }];
const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const detail = {
  id: INVENTORY_ID,
  number: "ИНВ-00042",
  status: "running",
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
  activeSnapshotId: "66666666-6666-4666-8666-666666666666",
  resultRevision: 8,
  createdAt: "2026-08-26T09:00:00.000Z",
  updatedAt: "2026-08-26T09:00:00.000Z",
  blockers: {
    activeParticipantCount: 2,
    pendingEventCount: 3,
    participantOpenBoxCount: 1,
    openRepackBoxCount: 1,
    unresolvedPrintBoxCount: 0,
  },
  imports: [],
  activeSnapshot: null,
};

const progress = {
  inventoryId: INVENTORY_ID,
  snapshotId: "66666666-6666-4666-8666-666666666666",
  status: "running",
  resultRevision: 8,
  expectedCount: 4116,
  verifiedCount: 312,
  missingCount: 3804,
  protectedCount: 207,
  protectedFoundCount: 0,
  ineligibleCount: 2,
  unknownCount: 1,
  dateMismatchCount: 1,
  voidedCount: 0,
  oldBoxCount: 4,
  newBoxCount: 2,
  invalidatedBoxCount: 0,
  pendingEventCount: 3,
  openBoxCount: 1,
  boxTotal: 1,
  boxesTruncated: false,
  participants: [
    {
      deviceId: "77777777-7777-4777-8777-777777777777",
      terminalName: "Станция упаковки № 1",
      operatorName: "Алексей П.",
      joinedAt: "2026-08-26T09:00:00.000Z",
      leftAt: null,
      heartbeatAt: "2026-08-26T09:10:00.000Z",
      state: "active",
      pendingEventCount: 3,
      openBoxCount: 1,
    },
    {
      deviceId: "88888888-8888-4888-8888-888888888888",
      terminalName: "Станция упаковки № 2",
      operatorName: "Мария К.",
      joinedAt: "2026-08-26T09:00:00.000Z",
      leftAt: null,
      heartbeatAt: "2026-08-26T09:05:00.000Z",
      state: "stale",
      pendingEventCount: 0,
      openBoxCount: 0,
    },
    {
      deviceId: "99999999-9999-4999-8999-999999999999",
      terminalName: "Станция упаковки № 3",
      operatorName: "Олег Н.",
      joinedAt: "2026-08-26T09:00:00.000Z",
      leftAt: "2026-08-26T09:09:00.000Z",
      heartbeatAt: "2026-08-26T09:09:00.000Z",
      state: "left",
      pendingEventCount: 0,
      openBoxCount: 0,
    },
  ],
  boxes: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sscc: "146000000000000012",
      terminalId: "77777777-7777-4777-8777-777777777777",
      terminalName: "Станция упаковки № 1",
      productionDate: "2025-09-19",
      state: "open",
      printState: "not_ready",
      itemCount: 7,
    },
  ],
  recentEvents: [
    {
      eventId: EVENT_ID,
      codeResultId: RESULT_ID,
      kind: "item",
      displayIdentity: "…00000042 / …4831",
      authoritativeVerdict: "applied",
      terminalId: "77777777-7777-4777-8777-777777777777",
      terminalName: "Станция упаковки № 1",
      scannedAt: "2026-08-26T09:10:00.000Z",
      classification: "unknown",
      observedProductionDate: "2025-09-19",
    },
  ],
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

function renderLive(progressResponses: unknown[] = [progress]) {
  let progressRequest = 0;
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
      if (url.endsWith("/api/access/me")) return response(ACCESS);
      if (url.includes("/api/pickup-orders")) return response({ items: [] });
      if (url === `/api/inventories/${INVENTORY_ID}`) return response(detail);
      if (url === "/api/inventory-document-formats") return response({ items: [] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({ items: [] });
      }
      if (url === `/api/inventories/${INVENTORY_ID}/progress`) {
        const body = progressResponses[Math.min(progressRequest, progressResponses.length - 1)];
        progressRequest += 1;
        return response(body);
      }
      if (url.startsWith(`/api/inventories/${INVENTORY_ID}/discrepancies`)) {
        return response({ page: 1, pageSize: 50, total: 4, hasMore: false, items: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [`/inventory/${INVENTORY_ID}`],
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
  return { router, getProgressRequestCount: () => progressRequest };
}

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("renders approved live evidence with stale participants and local pending work distinguished", async () => {
  renderLive();
  expect(await screen.findByRole("heading", { level: 1, name: "ИНВ-00042" })).toBeDefined();
  expect(screen.getByText("312")).toBeDefined();
  expect(screen.getByText("3 804")).toBeDefined();
  expect(screen.getAllByText("Станция упаковки № 1").length).toBeGreaterThan(0);
  expect(screen.getByText("Нет связи")).toBeDefined();
  expect(screen.getByText("Вышел")).toBeDefined();
  expect(screen.getByText(/3 события на терминалах/)).toBeDefined();
  expect(screen.getByText("146000000000000012")).toBeDefined();
  expect(screen.getByText("…00000042 / …4831")).toBeDefined();
  expect(screen.getByRole("link", { name: "Исправления" })).toBeDefined();
});

it("polls at the bounded interval while running and stops after the server reports closed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const closed = { ...progress, status: "closed" };
  const live = renderLive([progress, closed]);
  expect(await screen.findByRole("heading", { level: 1, name: "ИНВ-00042" })).toBeDefined();
  expect(live.getProgressRequestCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(5_000);
  await waitFor(() => expect(live.getProgressRequestCount()).toBe(2));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(live.getProgressRequestCount()).toBe(2);
});

it("fails closed when the live endpoint adds an unknown response field", async () => {
  renderLive([{ ...progress, privateProjection: true }]);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Не удалось загрузить ход инвентаризации",
  );
});

it("keeps zero metrics neutral and colors only non-zero ones", async () => {
  const zeroed = {
    ...progress,
    verifiedCount: 0,
    missingCount: 0,
    ineligibleCount: 0,
    unknownCount: 0,
    dateMismatchCount: 0,
  };
  renderLive([zeroed]);
  expect(await screen.findByRole("heading", { level: 1, name: "ИНВ-00042" })).toBeDefined();

  const verified = screen.getByText("Проверено").closest(".mk-inventory-live-metric")!;
  expect(verified.className).not.toContain("mk-inventory-live-metric--ok");
  const missing = screen.getByText("Не найдено").closest(".mk-inventory-live-metric")!;
  expect(missing.className).not.toContain("mk-inventory-live-metric--warn");
  const discrepancies = screen.getByText("Расхождения").closest(".mk-inventory-live-metric")!;
  expect(discrepancies.className).not.toContain("mk-inventory-live-metric--error");
});

it("colors non-zero metrics with the expected tone", async () => {
  renderLive();
  expect(await screen.findByRole("heading", { level: 1, name: "ИНВ-00042" })).toBeDefined();

  const verified = screen.getByText("Проверено").closest(".mk-inventory-live-metric")!;
  expect(verified.className).toContain("mk-inventory-live-metric--ok");
  const missing = screen.getByText("Не найдено").closest(".mk-inventory-live-metric")!;
  expect(missing.className).toContain("mk-inventory-live-metric--warn");
  const discrepancies = screen.getByText("Расхождения").closest(".mk-inventory-live-metric")!;
  expect(discrepancies.className).toContain("mk-inventory-live-metric--error");
});
