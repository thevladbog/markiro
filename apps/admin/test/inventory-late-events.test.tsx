// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { InventoryLateEvents } from "../src/pages/inventory/InventoryLateEvents.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const LATE_ID = "22222222-2222-4222-8222-222222222222";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderLateEvents(status: "running" | "closed" | "completed" = "closed") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <InventoryLateEvents
          inventoryId={INVENTORY_ID}
          inventoryStatus={status}
          open
          onClose={() => undefined}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("lists safe late-event metadata and discards selected evidence only with a reason", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return response({ discardedCount: 1 }, 201);
    return response({
      page: 1,
      pageSize: 50,
      total: 1,
      hasMore: false,
      items: [
        {
          id: LATE_ID,
          batchId: "late-batch-1",
          deviceId: "33333333-3333-4333-8333-333333333333",
          terminalName: "Станция упаковки № 1",
          eventCount: 2,
          receivedAt: "2026-08-26T12:00:00.000Z",
          closedRevision: 8,
          reason: "INVENTORY_CLOSED",
          resolution: "pending",
          resolvedAt: null,
          replayAvailable: false,
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderLateEvents();

  expect(await screen.findByText("Станция упаковки № 1")).toBeDefined();
  expect(screen.getByText("2 события")).toBeDefined();
  await userEvent.click(screen.getByRole("checkbox", { name: /late-batch-1/ }));
  expect(screen.getByRole("button", { name: "Исключить выбранные" }).hasAttribute("disabled")).toBe(
    true,
  );
  await userEvent.type(screen.getByLabelText("Причина решения"), "Проверено по журналу");
  await userEvent.click(screen.getByRole("button", { name: "Исключить выбранные" }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const [, init] = fetchMock.mock.calls.find(([, candidate]) => candidate?.method === "POST")!;
  expect(JSON.parse(String(init?.body))).toEqual({
    lateEventIds: [LATE_ID],
    reason: "Проверено по журналу",
  });
});

it("confirms whole-operation reopen before mutation, while completed evidence stays read-only", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return response(
        {
          inventoryId: INVENTORY_ID,
          status: "running",
          resultRevision: 9,
          invalidatedArtifactCount: 0,
        },
        201,
      );
    }
    return response({ page: 1, pageSize: 50, total: 0, hasMore: false, items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderLateEvents();
  await screen.findByText("Поздних событий нет");
  await userEvent.click(
    screen.getByRole("button", { name: "Возобновить для повторной обработки" }),
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  expect(screen.getByText(/ревизия результата увеличится/i)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Подтвердить возобновление" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const reopenCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
  expect(String(reopenCall?.[0])).toBe(`/api/inventories/${INVENTORY_ID}/reopen`);

  cleanup();
  renderLateEvents("completed");
  await screen.findByText("Поздних событий нет");
  expect(screen.queryByRole("button", { name: "Возобновить для повторной обработки" })).toBeNull();
  expect(screen.getByText("После завершения журнал доступен только для чтения")).toBeDefined();
});

it("explicitly replays authorized pending evidence while the inventory is running", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return response(
        {
          lateEventId: LATE_ID,
          resolution: "replayed",
          result: {
            inventoryId: INVENTORY_ID,
            snapshotId: "66666666-6666-4666-8666-666666666666",
            snapshotRevision: 1,
            batchId: "late-batch-replay",
            payloadDigest: "a".repeat(64),
            sequenceCeiling: 1,
            resultRevision: 9,
            outcomes: [
              {
                eventId: "44444444-4444-4444-8444-444444444444",
                status: "rejected",
                reasonCode: "INVENTORY_EVENT_REJECTED",
                claimedCount: 0,
                conflictCount: 0,
                claims: [],
              },
            ],
          },
        },
        201,
      );
    }
    return response({
      page: 1,
      pageSize: 50,
      total: 1,
      hasMore: false,
      items: [
        {
          id: LATE_ID,
          batchId: "late-batch-replay",
          deviceId: "33333333-3333-4333-8333-333333333333",
          terminalName: "Станция упаковки № 1",
          eventCount: 1,
          receivedAt: "2026-08-26T12:00:00.000Z",
          closedRevision: 8,
          reason: "INVENTORY_CLOSED",
          resolution: "pending",
          resolvedAt: null,
          replayAvailable: true,
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderLateEvents("running");

  await userEvent.click(
    await screen.findByRole("button", { name: /повторить обработку.*late-batch-replay/i }),
  );
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const replayCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
  expect(String(replayCall?.[0])).toBe(
    `/api/inventories/${INVENTORY_ID}/late-events/${LATE_ID}/replay`,
  );
  expect(screen.getByText("Пакет late-batch-replay обработан повторно")).toBeDefined();
});

it("caps selected late events at 100 across more than two pages", async () => {
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const page = Number(new URL(String(input), "https://admin.test").searchParams.get("page"));
    const start = (page - 1) * 50 + 1;
    const count = page < 3 ? 50 : 1;
    return response({
      page,
      pageSize: 50,
      total: 101,
      hasMore: page < 3,
      items: Array.from({ length: count }, (_, index) => {
        const sequence = start + index;
        return {
          id: id(sequence),
          batchId: `late-${sequence}`,
          deviceId: "33333333-3333-4333-8333-333333333333",
          terminalName: "Станция",
          eventCount: 1,
          receivedAt: "2026-08-26T12:00:00.000Z",
          closedRevision: 8,
          reason: "INVENTORY_CLOSED",
          resolution: "pending",
          resolvedAt: null,
          replayAvailable: false,
        };
      }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderLateEvents();

  for (const checkbox of await screen.findAllByRole("checkbox")) await userEvent.click(checkbox);
  await userEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
  await screen.findByText("Страница 2");
  for (const checkbox of screen.getAllByRole("checkbox")) await userEvent.click(checkbox);
  await userEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
  await screen.findByText("Страница 3");

  expect(screen.getByRole("checkbox", { name: /late-101/ }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/можно выбрать не более 100 пакетов/i)).toBeDefined();
});
