// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const WRITE_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};
const READ_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
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
    activeParticipantCount: 1,
    pendingEventCount: 0,
    participantOpenBoxCount: 0,
    openRepackBoxCount: 0,
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
  expectedCount: 10,
  verifiedCount: 1,
  missingCount: 9,
  protectedCount: 0,
  protectedFoundCount: 0,
  ineligibleCount: 0,
  unknownCount: 1,
  dateMismatchCount: 0,
  voidedCount: 0,
  oldBoxCount: 0,
  newBoxCount: 0,
  invalidatedBoxCount: 0,
  pendingEventCount: 0,
  openBoxCount: 0,
  participants: [],
  boxes: [],
  recentEvents: [
    {
      eventId: EVENT_ID,
      codeResultId: RESULT_ID,
      kind: "item",
      displayIdentity: "…00000042 / …4831",
      authoritativeVerdict: "applied",
      terminalId: "77777777-7777-4777-8777-777777777777",
      terminalName: "СТ-А-02",
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

function renderCorrections(access: AccessDocument = WRITE_ACCESS) {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (url === `/api/inventories/${INVENTORY_ID}`) return response(detail);
      if (url === `/api/inventories/${INVENTORY_ID}/progress`) return response(progress);
      if (url === `/api/inventories/${INVENTORY_ID}/corrections` && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return response(
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            action: "void_scan",
            reason: "Ошибочный скан",
            target: { eventId: EVENT_ID, codeResultId: RESULT_ID, repackBoxId: null },
            beforeProjectionDigest: "a".repeat(64),
            afterProjectionDigest: "b".repeat(64),
            resultRevision: 9,
            createdAt: "2026-08-26T09:11:00.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [`/inventory/${INVENTORY_ID}/corrections`],
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
  return { writes };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("requires a reason and posts the selected scan with revision and a bounded idempotency key", async () => {
  const { writes } = renderCorrections();
  expect(await screen.findByRole("heading", { name: "Исправления · ИНВ-00042" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать …00000042 / …4831" }));
  const submit = screen.getByRole("button", { name: "Отменить скан" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Причина исправления"), {
    target: { value: "Ошибочный скан" },
  });
  fireEvent.click(submit);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    action: "void_scan",
    target: { eventId: EVENT_ID },
    reason: "Ошибочный скан",
    expectedResultRevision: 8,
  });
  expect((writes[0] as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText("Исправление сохранено в аудите")).toBeDefined();
});

it("denies the corrections route to operations.read users before loading inventory evidence", async () => {
  renderCorrections(READ_ACCESS);
  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByText("…00000042 / …4831")).toBeNull();
});

it("does not expose mutation controls after the inventory is no longer running", async () => {
  detail.status = "closed";
  renderCorrections();
  expect(
    await screen.findByText("Исправления доступны только пока инвентаризация идёт"),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Отменить скан" })).toBeNull();
  detail.status = "running";
});
