import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { InventoryDetailPage } from "../src/pages/inventory/InventoryDetailPage.js";

const INVENTORY_ID = "11111111-1111-4111-8111-111111111111";
const LINE_ID = "33333333-3333-4333-8333-333333333333";

const DETAIL = {
  id: INVENTORY_ID,
  number: "ИНВ-00042",
  status: "ready",
  mode: "repack",
  productId: "22222222-2222-4222-8222-222222222222",
  gtin14: "04680089900383",
  productName: "Пиво светлое 0,45 л",
  lineId: LINE_ID,
  lineName: "Упаковка А",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  boxLabelTemplateId: "44444444-4444-4444-8444-444444444444",
  boxLabelTemplate: {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Короб 20 бутылок",
  },
  activeSnapshotId: "55555555-5555-4555-8555-555555555555",
  resultRevision: 0,
  createdAt: "2026-08-26T09:00:00.000Z",
  updatedAt: "2026-08-26T09:05:00.000Z",
  blockers: {
    activeParticipantCount: 0,
    pendingEventCount: 0,
    participantOpenBoxCount: 0,
    openRepackBoxCount: 0,
    unresolvedPrintBoxCount: 0,
  },
  imports: [],
  activeSnapshot: {
    id: "55555555-5555-4555-8555-555555555555",
    inventoryId: INVENTORY_ID,
    revision: 1,
    combinedDigest: "a".repeat(64),
    fixedAt: "2026-08-26T09:04:00.000Z",
    inputs: {
      EMITTED: "60000000-0000-4000-8000-000000000001",
      INTRODUCED: "60000000-0000-4000-8000-000000000002",
      APPLIED: "60000000-0000-4000-8000-000000000003",
      RETIRED: "60000000-0000-4000-8000-000000000004",
      WRITTEN_OFF: "60000000-0000-4000-8000-000000000005",
      DISAGGREGATION: "60000000-0000-4000-8000-000000000006",
    },
    counts: {
      emitted: 10,
      introduced: 4_116,
      applied: 0,
      retired: 0,
      writtenOff: 0,
      disaggregation: 0,
      protected: 2,
      expected: 4_116,
      packages: 0,
      loose: 4_116,
    },
  },
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const url = String(input);
      if (url === `/api/inventories/${INVENTORY_ID}`) return response(DETAIL);
      if (url === "/api/lines/presence") {
        return response({
          items: [
            {
              lineId: LINE_ID,
              lineName: "Упаковка А",
              assignedStations: 2,
              onlineStations: 1,
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <AccessProvider
          value={{ roles: ["member"], capabilities: [CABINET_CAPABILITY.OPERATIONS_READ] }}
        >
          <MemoryRouter initialEntries={[`/inventory/${INVENTORY_ID}`]}>
            <Routes>
              <Route path="/inventory/:inventoryId" element={<InventoryDetailPage />} />
            </Routes>
          </MemoryRouter>
        </AccessProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("opens the real HTML task form in a new tab for a read-only administrator", async () => {
  const openMock = vi.fn();
  vi.stubGlobal("open", openMock);
  const user = renderPage();

  const action = await screen.findByRole("button", { name: "Открыть форму-задание" });
  expect(action.hasAttribute("disabled")).toBe(false);
  expect(screen.queryByText("Скачать PDF")).toBeNull();

  await user.click(action);
  expect(openMock).toHaveBeenCalledWith(
    `/api/inventories/${INVENTORY_ID}/task-form`,
    "_blank",
    "noopener,noreferrer",
  );
});

it("localizes the task-form action in English without promising a PDF download", async () => {
  await i18n.changeLanguage("en");
  renderPage();

  expect(await screen.findByRole("button", { name: "Open task form" })).toBeDefined();
  expect(screen.queryByText("Download PDF")).toBeNull();
});
