// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { InventoryDocuments } from "../src/pages/inventory/InventoryDocuments.js";
import { inventoryDocumentArtifactSchema } from "../src/pages/inventory/schemas.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";

const format = {
  id: "inventory_csv_current_stock",
  version: 1,
  label: "[CSV] Коды на учёт",
  extension: "csv",
  mimeType: "text/csv; charset=utf-8",
  requiredSourceCategories: ["verified"],
  supportsParts: false,
  availability: "available",
} as const;

const balancesFormat = {
  id: "inventory_csv_balances_by_production_date",
  version: 1,
  label: "[CSV] Остатки по датам производства",
  extension: "csv",
  mimeType: "text/csv; charset=utf-8",
  requiredSourceCategories: ["verified", "protected", "newBoxes"],
  supportsParts: false,
  availability: "available",
} as const;

const emptyTxtFormat = {
  id: "inventory_txt_write_off",
  version: 1,
  label: "[TXT] Коды к списанию",
  extension: "txt",
  mimeType: "text/plain; charset=utf-8",
  requiredSourceCategories: ["writeOffCandidates", "protected"],
  supportsParts: false,
  availability: "available",
} as const;

const artifact = {
  id: ARTIFACT_ID,
  formatId: format.id,
  formatVersion: format.version,
  partNumber: 1,
  filename: "write-off.csv",
  mimeType: format.mimeType,
  rowCount: 12,
  codeCount: 12,
  boxCount: 0,
  byteSize: 420,
  sha256: "a".repeat(64),
  downloadedAt: null,
  invalidatedAt: null,
};

function run(status: "queued" | "processing" | "ready" | "failed", overrides = {}) {
  return {
    id: RUN_ID,
    inventoryId: INVENTORY_ID,
    resultRevision: 8,
    selectedFormats: [{ id: format.id, version: format.version }],
    status,
    errorCode: status === "failed" ? "GENERATION_FAILED" : null,
    sourceSnapshotStartedAt: status === "queued" ? null : "2026-08-26T09:01:00.000Z",
    sourceSnapshotCompletedAt: status === "ready" ? "2026-08-26T09:02:00.000Z" : null,
    completedAt: status === "ready" ? "2026-08-26T09:02:00.000Z" : null,
    attemptCount: status === "queued" ? 0 : 1,
    createdAt: "2026-08-26T09:00:00.000Z",
    artifacts: status === "ready" ? [artifact] : [],
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDocuments(status: "running" | "closed" | "completed" = "closed") {
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
          canWrite
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("shows the catalog gate without inventing formats or a generate action", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({ items: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  renderDocuments();

  expect(await screen.findByText("Форматы документов пока не утверждены")).toBeDefined();
  expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Сформировать документы" })).toBeNull();
});

it("submits arbitrary catalog selections in server order with exact versions and polls pending runs", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let listCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "/api/inventory-document-formats") {
        return response({ items: [format, balancesFormat] });
      }
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs` && !init?.method) {
        listCount += 1;
        return response({
          items: listCount === 1 ? [] : [run(listCount === 2 ? "queued" : "ready")],
        });
      }
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs` && init?.method === "POST") {
        return response(run("queued"), 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments();

  const currentStockChoice = await screen.findByRole("checkbox", { name: /\[CSV\] Коды на учёт/ });
  const balancesChoice = screen.getByRole("checkbox", {
    name: /\[CSV\] Остатки по датам производства/,
  });
  expect(
    screen.getByRole("button", { name: "Сформировать документы" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(balancesChoice);
  await userEvent.click(currentStockChoice);
  await userEvent.click(screen.getByRole("button", { name: "Сформировать документы" }));

  await waitFor(() => expect(requests.some(({ init }) => init?.method === "POST")).toBe(true));
  const createRequest = requests.find(({ init }) => init?.method === "POST")!;
  const body = JSON.parse(String(createRequest.init?.body)) as {
    selectedFormats: unknown;
    idempotencyKey: string;
  };
  expect(body.selectedFormats).toEqual([
    { id: "inventory_csv_current_stock", version: 1 },
    { id: "inventory_csv_balances_by_production_date", version: 1 },
  ]);
  expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText("В очереди")).toBeDefined();

  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(await screen.findByText("Готово")).toBeDefined();
  const countAfterReady = listCount;
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  expect(listCount).toBe(countAfterReady);
});

it("accepts zero-byte artifact metadata but rejects negative byte sizes", () => {
  expect(inventoryDocumentArtifactSchema.safeParse({ ...artifact, byteSize: 0 }).success).toBe(
    true,
  );
  expect(inventoryDocumentArtifactSchema.safeParse({ ...artifact, byteSize: -1 }).success).toBe(
    false,
  );
});

it("keeps polling a pending run after reopen until stale-revision failure is visible", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let listCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        listCount += 1;
        return response({
          items: [
            run(listCount === 1 ? "processing" : "failed", {
              errorCode: listCount === 1 ? null : "STALE_RESULT_REVISION",
            }),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments("running");

  expect(await screen.findByText("Формируется")).toBeDefined();
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(await screen.findByText(/STALE_RESULT_REVISION/)).toBeDefined();
  const countAfterFailure = listCount;
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  expect(listCount).toBe(countAfterFailure);
});

it("turns server contract failures into an actionable localized message", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs` && !init?.method) {
        return response({ items: [] });
      }
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs` && init?.method === "POST") {
        return response({ code: "INVENTORY_DOCUMENT_FORMAT_SUPERSEDED" }, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments();

  await userEvent.click(await screen.findByRole("checkbox", { name: /Коды на учёт/ }));
  await userEvent.click(screen.getByRole("button", { name: "Сформировать документы" }));

  expect(
    await screen.findByText(
      "Состав форматов изменился. Обновите страницу и выберите документы заново.",
    ),
  ).toBeDefined();
});

it("retries safe failures while an inventory remains closed", async () => {
  const retry = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({
          items: [run("failed")],
        });
      }
      if (url === `/api/inventory-document-runs/${RUN_ID}/retry` && init?.method === "POST") {
        retry();
        return response(run("queued"), 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  renderDocuments("closed");

  expect(await screen.findByText(/Формирование не удалось/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Повторить формирование" }));
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
});

it("explains a missing verified production date in actionable Russian", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({
          items: [
            run("failed", {
              errorCode: "VERIFIED_PRODUCTION_DATE_MISSING",
            }),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  renderDocuments("closed");

  expect(
    await screen.findByText(
      "У проверенных кодов не указана дата производства. Возобновите инвентаризацию, исправьте даты и сформируйте документы заново.",
    ),
  ).toBeDefined();
  expect(screen.queryByText(/VERIFIED_PRODUCTION_DATE_MISSING/)).toBeNull();
});

it("explains a missing verified production date in actionable English", async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({
          items: [
            run("failed", {
              errorCode: "VERIFIED_PRODUCTION_DATE_MISSING",
            }),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  renderDocuments("closed");

  expect(
    await screen.findByText(
      "Verified codes do not have a production date. Resume the inventory, correct the dates, and generate the documents again.",
    ),
  ).toBeDefined();
  expect(screen.queryByText(/VERIFIED_PRODUCTION_DATE_MISSING/)).toBeNull();
});

it("keeps invalidated artifacts visibly unavailable after reopening", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [format] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({
          items: [
            run("ready", {
              resultRevision: 7,
              artifacts: [
                {
                  ...artifact,
                  invalidatedAt: "2026-08-26T10:00:00.000Z",
                },
              ],
            }),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  renderDocuments("running");

  expect(await screen.findByText("Документ аннулирован после возобновления")).toBeDefined();
  expect(screen.getByRole("button", { name: "Недоступен" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Сформировать документы" })).toBeNull();
});

it("downloads an artifact or ZIP through the tenant-scoped API response", async () => {
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const emptyTxtArtifact = {
    ...artifact,
    formatId: emptyTxtFormat.id,
    formatVersion: emptyTxtFormat.version,
    filename: "write-off.txt",
    mimeType: emptyTxtFormat.mimeType,
    rowCount: 0,
    codeCount: 0,
    byteSize: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/inventory-document-formats") return response({ items: [emptyTxtFormat] });
      if (url === `/api/inventories/${INVENTORY_ID}/document-runs`) {
        return response({ items: [run("ready", { artifacts: [emptyTxtArtifact] })] });
      }
      if (url === `/api/inventory-document-runs/${RUN_ID}/artifacts/${ARTIFACT_ID}/download`) {
        return response({
          url: "https://objects.example/download-artifact",
          filename: emptyTxtArtifact.filename,
          expiresInSeconds: 300,
        });
      }
      if (url === `/api/inventory-document-runs/${RUN_ID}/download`) {
        return response({
          url: "https://objects.example/download-zip",
          filename: "inventory.zip",
          expiresInSeconds: 300,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  renderDocuments();

  expect(await screen.findByText("кодов: 0 · коробов: 0 · 0 байт")).toBeDefined();
  const artifactDownload = screen.getByRole("button", { name: "Скачать write-off.txt" });
  const zipDownload = screen.getByRole("button", { name: "Скачать ZIP" });
  expect(artifactDownload.hasAttribute("disabled")).toBe(false);
  expect(zipDownload.hasAttribute("disabled")).toBe(false);
  await userEvent.click(artifactDownload);
  await userEvent.click(zipDownload);

  await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(2));
  expect((anchorClick.mock.instances[0] as HTMLAnchorElement | undefined)?.href).toBe(
    "https://objects.example/download-artifact",
  );
  expect((anchorClick.mock.instances[0] as HTMLAnchorElement | undefined)?.rel).toBe(
    "noopener noreferrer",
  );
  expect((anchorClick.mock.instances[1] as HTMLAnchorElement | undefined)?.href).toBe(
    "https://objects.example/download-zip",
  );
});
