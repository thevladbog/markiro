// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { InventoryDocuments } from "../src/pages/inventory/InventoryDocuments.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const readyRun = {
  id: "22222222-2222-4222-8222-222222222222",
  inventoryId: INVENTORY_ID,
  resultRevision: 8,
  selectedFormats: [{ id: "write_off_csv", version: 3 }],
  status: "ready",
  errorCode: null,
  sourceSnapshotStartedAt: "2026-08-26T09:01:00.000Z",
  sourceSnapshotCompletedAt: "2026-08-26T09:02:00.000Z",
  completedAt: "2026-08-26T09:02:00.000Z",
  attemptCount: 1,
  createdAt: "2026-08-26T09:00:00.000Z",
  artifacts: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      formatId: "write_off_csv",
      formatVersion: 3,
      partNumber: 1,
      filename: "write-off.csv",
      mimeType: "text/csv; charset=utf-8",
      rowCount: 12,
      codeCount: 12,
      boxCount: 0,
      byteSize: 420,
      sha256: "a".repeat(64),
      downloadedAt: "2026-08-26T09:03:00.000Z",
      invalidatedAt: null,
    },
  ],
};

const format = {
  id: "write_off_csv",
  version: 3,
  label: "Коды к списанию (CSV)",
  extension: "csv",
  mimeType: "text/csv; charset=utf-8",
  requiredSourceCategories: ["writeOffCandidates"],
  supportsParts: false,
  availability: "available",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDocuments(status: "closed" | "completed", canWrite = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <InventoryDocuments
          inventoryId={INVENTORY_ID}
          inventoryStatus={status}
          resultRevision={8}
          canWrite={canWrite}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps completion separate and requires current downloaded artifacts plus acknowledgement", async () => {
  const completed = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({ items: [readyRun] });
      }
      if (url === `/api/inventories/${INVENTORY_ID}/complete` && init?.method === "POST") {
        completed(JSON.parse(String(init.body)));
        return response(
          {
            inventoryId: INVENTORY_ID,
            status: "completed",
            resultRevision: 8,
            completedAt: "2026-08-26T09:04:00.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments("closed");

  const complete = await screen.findByRole("button", { name: "Завершить инвентаризацию" });
  expect(complete.hasAttribute("disabled")).toBe(true);
  await userEvent.click(
    screen.getByRole("checkbox", { name: "Итоговые документы скачаны и проверены" }),
  );
  expect(complete.hasAttribute("disabled")).toBe(false);
  await userEvent.click(complete);

  await waitFor(() =>
    expect(completed).toHaveBeenCalledWith({ documentsDownloadedAndChecked: true }),
  );
  expect(await screen.findByText("Инвентаризация завершена")).toBeDefined();
});

it("does not permit acknowledgement when any current artifact is not downloaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({
          items: [
            {
              ...readyRun,
              artifacts: [{ ...readyRun.artifacts[0], downloadedAt: null }],
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments("closed");

  const acknowledgement = await screen.findByRole("checkbox", {
    name: "Итоговые документы скачаны и проверены",
  });
  expect(acknowledgement.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Сначала скачайте все документы текущего результата")).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Завершить инвентаризацию" }).hasAttribute("disabled"),
  ).toBe(true);
});

it("renders completed inventory as read-only without generation, retry, or completion controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({ items: [readyRun] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments("completed");

  expect(
    await screen.findByText(
      "Инвентаризация завершена — документы доступны только для просмотра и скачивания",
    ),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Сформировать документы" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Повторить формирование" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Завершить инвентаризацию" })).toBeNull();
  expect(
    (await screen.findByRole("checkbox", { name: /Коды к списанию/ })).hasAttribute("disabled"),
  ).toBe(true);
});
