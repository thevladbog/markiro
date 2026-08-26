// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { InventoryClosePanel } from "../src/pages/inventory/InventoryClosePanel.js";
import type { InventoryProgress } from "../src/pages/inventory/schemas.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";

const progress: InventoryProgress = {
  inventoryId: INVENTORY_ID,
  snapshotId: "66666666-6666-4666-8666-666666666666",
  status: "running",
  resultRevision: 8,
  expectedCount: 10,
  verifiedCount: 10,
  missingCount: 0,
  protectedCount: 0,
  protectedFoundCount: 0,
  ineligibleCount: 0,
  unknownCount: 0,
  dateMismatchCount: 0,
  voidedCount: 0,
  oldBoxCount: 0,
  newBoxCount: 0,
  invalidatedBoxCount: 0,
  pendingEventCount: 0,
  openBoxCount: 0,
  boxTotal: 0,
  boxesTruncated: false,
  participants: [],
  boxes: [],
  recentEvents: [],
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel(status: "running" | "closed" | "completed", value = progress) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <InventoryClosePanel inventoryId={INVENTORY_ID} status={status} progress={value} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("safely closes a blocker-free running inventory without an emergency acknowledgement", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).endsWith("/close-preview")) {
      return new Response(
        JSON.stringify({
          inventoryId: INVENTORY_ID,
          status: "running",
          resultRevision: 8,
          blockers: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return response({
      inventoryId: INVENTORY_ID,
      status: "closed",
      resultRevision: 8,
      closedAt: "2026-08-26T12:00:00.000Z",
      emergency: false,
      blockers: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel("running");

  await userEvent.click(screen.getByRole("button", { name: "Закрыть инвентаризацию" }));
  expect(screen.getByRole("dialog")).toBeDefined();
  await userEvent.click(await screen.findByRole("button", { name: "Закрыть безопасно" }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const [url, init] = fetchMock.mock.calls.find(([, candidate]) => candidate?.method === "POST")!;
  expect(String(url)).toBe(`/api/inventories/${INVENTORY_ID}/close`);
  expect(init).toMatchObject({ method: "POST", body: "{}" });
  expect(await screen.findByText("Инвентаризация закрыта")).toBeDefined();
});

it("requires a reason and explicit blocker acknowledgement for emergency close", async () => {
  const blocked: InventoryProgress = {
    ...progress,
    pendingEventCount: 3,
    participants: [
      {
        deviceId: "77777777-7777-4777-8777-777777777777",
        terminalName: "Станция № 1",
        operatorName: "Оператор",
        joinedAt: "2026-08-26T09:00:00.000Z",
        leftAt: null,
        heartbeatAt: "2026-08-26T09:10:00.000Z",
        state: "active",
        pendingEventCount: 3,
        openBoxCount: 0,
      },
    ],
  };
  const blockers = [
    {
      code: "ACTIVE_PARTICIPANT",
      count: 1,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
    {
      code: "PENDING_OUTBOX",
      count: 3,
      participantId: null,
      deviceId: null,
      boxId: null,
      discrepancyCategory: null,
    },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).endsWith("/close-preview")) {
      return new Response(
        JSON.stringify({
          inventoryId: INVENTORY_ID,
          status: "running",
          resultRevision: 8,
          blockers,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return response({
      inventoryId: INVENTORY_ID,
      status: "closed",
      resultRevision: 8,
      closedAt: "2026-08-26T12:00:00.000Z",
      emergency: true,
      blockers,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel("running", blocked);

  await userEvent.click(screen.getByRole("button", { name: "Закрыть инвентаризацию" }));
  expect(await screen.findByText("Активные терминалы: 1")).toBeDefined();
  expect(screen.getByText("Несинхронизированные события: 3")).toBeDefined();
  expect(screen.getByRole("button", { name: "Закрыть безопасно" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByRole("button", { name: "Закрыть аварийно" }).hasAttribute("disabled")).toBe(
    true,
  );

  await userEvent.type(screen.getByLabelText("Причина аварийного закрытия"), "Склад остановлен");
  await userEvent.click(
    screen.getByRole("checkbox", { name: /понимаю, что блокировки останутся/ }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Закрыть аварийно" }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
  );
  const [, emergencyInit] = fetchMock.mock.calls.find(
    ([, candidate]) => candidate?.method === "POST",
  )!;
  expect(JSON.parse(String(emergencyInit?.body))).toEqual({
    reason: "Склад остановлен",
    acknowledgeBlockers: true,
  });
});

it("confirms reopen before mutation and does not offer completion before Task 8", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    response({
      inventoryId: INVENTORY_ID,
      status: "running",
      resultRevision: 9,
      invalidatedArtifactCount: 0,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderPanel("closed", { ...progress, status: "closed" });

  expect(screen.queryByRole("button", { name: "Завершить инвентаризацию" })).toBeNull();
  expect(screen.getByText(/завершение станет доступно после формирования,/i)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Возобновить" }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByText(/ревизия результата увеличится/i)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Подтвердить возобновление" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/inventories/${INVENTORY_ID}/reopen`);

  cleanup();
  renderPanel("completed", { ...progress, status: "completed" });
  expect(screen.getByText("Инвентаризация завершена и недоступна для изменений")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Возобновить" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Завершить инвентаризацию" })).toBeNull();
});

it("allows an authoritative close after preview failure and shows its 409 blockers", async () => {
  const serverBlocker = {
    code: "VOIDED",
    count: 2,
    participantId: null,
    deviceId: null,
    boxId: null,
    discrepancyCategory: "voided",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/close-preview")) {
      return new Response("preview unavailable", { status: 503, statusText: "Unavailable" });
    }
    return new Response(
      JSON.stringify({
        code: "INVENTORY_CLOSE_BLOCKED",
        resultRevision: 9,
        blockers: [{ ...serverBlocker, code: "UNRESOLVED_DISCREPANCY" }],
      }),
      { status: 409, statusText: "Conflict", headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  renderPanel("running");

  await userEvent.click(screen.getByRole("button", { name: "Закрыть инвентаризацию" }));
  expect(await screen.findByText(/Не удалось получить предварительную проверку/)).toBeDefined();
  const safeClose = screen.getByRole("button", { name: "Закрыть безопасно" });
  expect(safeClose.getAttribute("disabled")).toBeNull();
  await userEvent.click(safeClose);
  expect(await screen.findByText("Обязательные расхождения без решения: 2")).toBeDefined();
  expect(screen.getByRole("button", { name: "Закрыть аварийно" })).toBeDefined();
});
