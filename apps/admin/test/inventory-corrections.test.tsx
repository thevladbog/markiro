// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
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
import { useCreateInventoryCorrectionBatch } from "../src/pages/inventory/api.js";
import type { InventoryEvidenceResponse } from "../src/pages/inventory/schemas.js";

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
  number: "IVN-26-0042",
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
  boxTotal: 0,
  boxesTruncated: false,
  verifiedBoxTotal: 0,
  verifiedBoxesTruncated: false,
  participants: [],
  boxes: [],
  verifiedBoxes: [],
  recentEvents: [
    {
      eventId: EVENT_ID,
      codeResultId: RESULT_ID,
      kind: "item",
      displayIdentity: "(01)04680089900383 (21)SERIAL-42",
      authoritativeVerdict: "applied",
      terminalId: "77777777-7777-4777-8777-777777777777",
      terminalName: "СТ-А-02",
      scannedAt: "2026-08-26T09:10:00.000Z",
      classification: "unknown",
      observedProductionDate: "2025-09-19",
    },
  ],
};

const evidence: InventoryEvidenceResponse = {
  page: 1,
  pageSize: 50,
  total: 2,
  hasMore: false,
  allMatchingActions: ["void_scan", "change_date"],
  allMatchingAffectedCodeCount: 1,
  items: [
    {
      eventId: EVENT_ID,
      codeResultId: RESULT_ID,
      kind: "item",
      displayIdentity: "(01)04680089900383 (21)SERIAL-42",
      authoritativeVerdict: "applied",
      terminalId: "77777777-7777-4777-8777-777777777777",
      terminalName: "СТ-А-02",
      scannedAt: "2026-08-26T09:10:00.000Z",
      classification: "unknown",
      observedProductionDate: "2025-09-19",
      copyIdentity: "010468008990038321SERIAL-42",
      affectedCodeCount: 1,
      discrepancyCodeCount: 1,
      classifications: ["unknown"],
      discrepancyCategories: ["unknown"],
      actions: ["void_scan", "change_date"],
    },
    {
      eventId: "99999999-9999-4999-8999-999999999999",
      codeResultId: null,
      kind: "item",
      authoritativeVerdict: "duplicate",
      displayIdentity: "duplicate evidence",
      terminalId: "77777777-7777-4777-8777-777777777777",
      terminalName: "СТ-А-02",
      scannedAt: "2026-08-26T09:10:01.000Z",
      classification: null,
      observedProductionDate: null,
      copyIdentity: null,
      affectedCodeCount: 0,
      discrepancyCodeCount: 0,
      classifications: [],
      discrepancyCategories: [],
      actions: [],
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

interface RenderCorrectionsOptions {
  entry?: string;
  batchResponses?: Array<Response | Error>;
}

function renderCorrections(
  access: AccessDocument = WRITE_ACCESS,
  options: RenderCorrectionsOptions = {},
) {
  const writes: unknown[] = [];
  const batchResponses = [...(options.batchResponses ?? [])];
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
      if (url.startsWith(`/api/inventories/${INVENTORY_ID}/evidence`)) return response(evidence);
      if (url === `/api/inventories/${INVENTORY_ID}/corrections/batch` && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        const next = batchResponses.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        return response(
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            action: "void_scan",
            selectedEventCount: 1,
            affectedCodeCount: 1,
            resultRevision: 9,
            createdAt: "2026-08-26T09:11:00.000Z",
          },
          201,
        );
      }
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
    initialEntries: [options.entry ?? `/inventory/${INVENTORY_ID}/corrections`],
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
  return { writes, router };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("posts a strict batch correction with the exact filter snapshot and exclusions", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return response(
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          action: "change_date",
          selectedEventCount: 8,
          affectedCodeCount: 27,
          resultRevision: 9,
          createdAt: "2026-08-26T09:11:00.000Z",
        },
        201,
      );
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCreateInventoryCorrectionBatch(), { wrapper });

  await act(async () => {
    await result.current.mutateAsync({
      inventoryId: INVENTORY_ID,
      correction: {
        action: "change_date",
        selection: {
          mode: "all_matching",
          filter: {
            scope: "discrepancies",
            search: "0468",
            discrepancyCategory: "unknown",
          },
          excludedEventIds: [EVENT_ID],
        },
        observedProductionDate: "2025-09-20",
        reason: "Исправление даты партии",
        expectedResultRevision: 8,
        idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
  });

  expect(writes).toEqual([
    {
      action: "change_date",
      selection: {
        mode: "all_matching",
        filter: {
          scope: "discrepancies",
          search: "0468",
          discrepancyCategory: "unknown",
        },
        excludedEventIds: [EVENT_ID],
      },
      observedProductionDate: "2025-09-20",
      reason: "Исправление даты партии",
      expectedResultRevision: 8,
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  ]);
});

it("opens the discrepancy view and copies only the canonical identity", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  renderCorrections(WRITE_ACCESS, {
    entry: `/inventory/${INVENTORY_ID}/corrections?view=discrepancies`,
  });

  expect(await screen.findByRole("tab", { name: "Расхождения", selected: true })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Копировать код" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("010468008990038321SERIAL-42"));
  expect(screen.getByText("Код для копирования недоступен")).toBeDefined();
});

it("selects all filtered events, keeps exclusions, and submits one batch", async () => {
  const original = {
    items: evidence.items,
    total: evidence.total,
    actions: evidence.allMatchingActions,
    affected: evidence.allMatchingAffectedCodeCount,
  };
  const first = evidence.items[0];
  if (!first) throw new Error("Expected actionable evidence fixture");
  const excludedEventId = "88888888-8888-4888-8888-888888888888";
  evidence.items = [
    first,
    {
      ...first,
      eventId: excludedEventId,
      codeResultId: "77777777-7777-4777-8777-777777777778",
      displayIdentity: "(01)04680089900383 (21)SERIAL-43",
      copyIdentity: "010468008990038321SERIAL-43",
    },
  ];
  evidence.total = 2582;
  evidence.allMatchingActions = ["void_scan", "change_date"];
  evidence.allMatchingAffectedCodeCount = 2600;
  try {
    const { writes } = renderCorrections(WRITE_ACCESS, {
      entry: `/inventory/${INVENTORY_ID}/corrections?view=discrepancies`,
    });
    await screen.findByRole("tab", { name: "Расхождения", selected: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Выбрать страницу" }));
    expect(screen.getByText("Выбрано на странице: 2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать все 2 582 по текущему фильтру" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Выбрать событие (01)04680089900383 (21)SERIAL-43",
      }),
    );
    expect(screen.getByText("Выбрано событий: 2 581 · кодов: 2 599")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Отменить выбранные сканы" }));
    expect(screen.getByRole("dialog", { name: "Отмена выбранных сканов" })).toBeDefined();
    fireEvent.change(screen.getByLabelText("Причина исправления"), {
      target: { value: "Проверено по журналу" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      action: "void_scan",
      selection: {
        mode: "all_matching",
        filter: { scope: "discrepancies" },
        excludedEventIds: [excludedEventId],
      },
      reason: "Проверено по журналу",
      expectedResultRevision: 8,
    });
    expect((writes[0] as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("Исправлено событий: 1 · кодов: 1")).toBeDefined();
  } finally {
    evidence.items = original.items;
    evidence.total = original.total;
    evidence.allMatchingActions = original.actions;
    evidence.allMatchingAffectedCodeCount = original.affected;
  }
});

it("clears the bulk selection when the evidence filter changes", async () => {
  const first = evidence.items[0];
  if (!first) throw new Error("Expected actionable evidence fixture");
  renderCorrections(WRITE_ACCESS, {
    entry: `/inventory/${INVENTORY_ID}/corrections?view=discrepancies`,
  });

  await screen.findByText(first.displayIdentity);
  fireEvent.click(
    screen.getByRole("checkbox", { name: `Выбрать событие ${first.displayIdentity}` }),
  );
  expect(screen.getByText("Выбрано событий: 1 · кодов: 1")).toBeDefined();

  fireEvent.change(screen.getByLabelText("Поиск по событиям"), {
    target: { value: "SERIAL-42" },
  });

  await waitFor(() => expect(screen.queryByText(/Выбрано событий:/)).toBeNull());
});

it("reuses the batch key after a network failure and resets stale selections", async () => {
  const first = evidence.items[0];
  if (!first) throw new Error("Expected actionable evidence fixture");
  const network = renderCorrections(WRITE_ACCESS, {
    batchResponses: [new Error("offline")],
  });
  await screen.findByText(first.displayIdentity);
  fireEvent.click(
    screen.getByRole("checkbox", { name: `Выбрать событие ${first.displayIdentity}` }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Отменить выбранные сканы" }));
  fireEvent.change(screen.getByLabelText("Причина исправления"), {
    target: { value: "Сверено" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));
  expect(await screen.findByText("Связь прервалась. Повторите с тем же запросом.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));
  await waitFor(() => expect(network.writes).toHaveLength(2));
  expect(
    network.writes.map((write) => (write as { idempotencyKey: string }).idempotencyKey),
  ).toEqual([
    (network.writes[0] as { idempotencyKey: string }).idempotencyKey,
    (network.writes[0] as { idempotencyKey: string }).idempotencyKey,
  ]);
  cleanup();
  network.router.dispose();

  const stale = renderCorrections(WRITE_ACCESS, {
    batchResponses: [
      response({ code: "INVENTORY_CORRECTION_STALE_REVISION", resultRevision: 9 }, 409),
    ],
  });
  await screen.findByText(first.displayIdentity);
  fireEvent.click(
    screen.getByRole("checkbox", { name: `Выбрать событие ${first.displayIdentity}` }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Отменить выбранные сканы" }));
  fireEvent.change(screen.getByLabelText("Причина исправления"), {
    target: { value: "Сверено" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));
  expect(
    await screen.findByText("Данные изменились. Выберите события заново и повторите действие."),
  ).toBeDefined();
  expect(screen.queryByText(/Выбрано событий:/)).toBeNull();
  stale.router.dispose();
});

it("requires a reason and posts the selected scan with revision and a bounded idempotency key", async () => {
  const { writes } = renderCorrections();
  expect(await screen.findByRole("heading", { name: "Исправления · IVN-26-0042" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать (01)04680089900383 (21)SERIAL-42" }));
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
  expect(screen.queryByText("(01)04680089900383 (21)SERIAL-42")).toBeNull();
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

it("derives immutability from the latest progress status and hides all controls after runtime close", async () => {
  progress.status = "closed";
  renderCorrections();
  expect(
    await screen.findByText("Исправления доступны только пока инвентаризация идёт"),
  ).toBeDefined();
  expect(
    screen.queryByRole("button", { name: "Выбрать (01)04680089900383 (21)SERIAL-42" }),
  ).toBeNull();
  progress.status = "running";
});

it("uses paginated evidence actions and never offers controls for duplicate nonwinning events", async () => {
  renderCorrections();
  expect(await screen.findByText("duplicate evidence")).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Выбрать (01)04680089900383 (21)SERIAL-42" }),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Выбрать duplicate evidence" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Поиск по событиям"), {
    target: { value: "00000042" },
  });
  await waitFor(() => {
    const requested = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input))
      .find((url) => url.includes("/evidence?") && url.includes("search=00000042"));
    expect(requested).toBeDefined();
  });
});

it("does not render a date correction when evidence permits only voiding an active membership", async () => {
  const originalItems = evidence.items;
  const originalTotal = evidence.total;
  const sourceEvent = originalItems[0];
  if (!sourceEvent) throw new Error("Expected correction evidence fixture");
  evidence.items = [{ ...sourceEvent, actions: ["void_scan"] }];
  evidence.total = 1;
  try {
    renderCorrections();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Выбрать (01)04680089900383 (21)SERIAL-42",
      }),
    );
    expect(screen.getByRole("button", { name: "Отменить скан" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Изменить дату" })).toBeNull();
  } finally {
    evidence.items = originalItems;
    evidence.total = originalTotal;
  }
});

it("shows the recorded production date, preloads date correction, and hides repack boxes in check mode", async () => {
  renderCorrections();

  expect(await screen.findByText("Дата производства: 19.09.2025")).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Новые короба" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Изменить дату" }));
  expect((screen.getByLabelText("Новая дата производства") as HTMLInputElement).value).toBe(
    "2025-09-19",
  );
});

it("offers reprint only for a closed printed box and never for open, invalidated, or pending boxes", async () => {
  const mutableDetail = detail as unknown as {
    mode: "check" | "repack";
    boxLabelTemplateId: string | null;
    boxLabelTemplate: { id: string; name: string } | null;
  };
  const originalMode = mutableDetail.mode;
  const originalTemplateId = mutableDetail.boxLabelTemplateId;
  const originalTemplate = mutableDetail.boxLabelTemplate;
  const mutableProgress = progress as unknown as {
    boxTotal: number;
    boxes: ReturnType<typeof box>[];
  };
  mutableDetail.mode = "repack";
  mutableDetail.boxLabelTemplateId = "abababab-abab-4bab-8bab-abababababab";
  mutableDetail.boxLabelTemplate = {
    id: "abababab-abab-4bab-8bab-abababababab",
    name: "Короб 20",
  };
  mutableProgress.boxTotal = 4;
  mutableProgress.boxes = [
    box("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "146000000000000012", "open", "not_ready"),
    box("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "246000000000000019", "closed", "printed"),
    box("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "346000000000000016", "invalidated", "printed"),
    box("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "446000000000000013", "closed", "pending"),
  ];
  try {
    renderCorrections();
    expect(await screen.findByRole("heading", { name: "Новые короба" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Поставить перепечать в очередь" })).toHaveLength(
      1,
    );
  } finally {
    mutableDetail.mode = originalMode;
    mutableDetail.boxLabelTemplateId = originalTemplateId;
    mutableDetail.boxLabelTemplate = originalTemplate;
    mutableProgress.boxes = [];
    mutableProgress.boxTotal = 0;
  }
});

function box(id: string, sscc: string, state: string, printState: string) {
  return {
    id,
    sscc,
    terminalId: "77777777-7777-4777-8777-777777777777",
    terminalName: "СТ-А-02",
    productionDate: "2025-09-19",
    state,
    printState,
    itemCount: 1,
  };
}
