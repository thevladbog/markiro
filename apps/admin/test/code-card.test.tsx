import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { CodeCardPage } from "../src/pages/code-search/CodeCard.js";

const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const CODE_CARD = {
  codeHash: "a".repeat(64),
  gtin14: "04630000000001",
  serial: "SN0001",
  productId: "p1",
  productName: "Молоко 1л",
  status: "aggregated" as const,
  currentBox: { id: "b1", sscc: "00000000000000000001" },
  history: [
    {
      type: "scanned" as const,
      at: "2026-08-20T08:00:00.000Z",
      verdict: "accepted",
      shiftId: "sh1",
      terminalId: "t1",
      operatorId: "op1",
    },
    {
      type: "box_added" as const,
      at: "2026-08-20T08:01:00.000Z",
      boxId: "b1",
      boxSscc: "00000000000000000001",
    },
    {
      type: "box_disassembled" as const,
      at: "2026-08-20T09:00:00.000Z",
      boxId: "b2",
      boxSscc: "00000000000000000002",
      reason: "damaged",
      disaggregationDocumentId: "d1",
      disaggregationDocNo: "DSG-26-0001",
    },
  ],
};

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/api/code-search/codes/")) {
      return jsonResponse(200, CODE_CARD);
    }
    return jsonResponse(404, { message: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <>
        <Route path="/codes/km/:codeHash" element={<CodeCardPage />} />
        <Route path="/codes/box/:boxId" element={<div>Box card stub</div>} />
        <Route path="/disaggregation/:id" element={<div>Doc stub</div>} />
        <Route path="/pickup/:id" element={<div>Order stub</div>} />
      </>,
    ),
    { initialEntries: [`/codes/km/${CODE_CARD.codeHash}`] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CodeCardPage", () => {
  it("renders code details, status, current box, and history with contextual links", async () => {
    stubFetch();
    renderPage();

    expect(await screen.findByText("Молоко 1л")).toBeTruthy();
    expect(screen.getByText("В коробе")).toBeTruthy();

    // Current box links to the box card, shown in SSCC HRI form.
    const boxLinks = screen.getAllByRole("link", { name: /000000000000000001/i });
    expect(boxLinks.some((link) => link.getAttribute("href") === "/codes/box/b1")).toBe(true);

    // History rows render in given order with per-type labels.
    expect(screen.getByText("Скан")).toBeTruthy();
    expect(screen.getByText("Добавлен в короб")).toBeTruthy();
    expect(screen.getByText("Короб расформирован")).toBeTruthy();

    // box_disassembled links to the disaggregation document, labeled with its number.
    const docLink = screen.getByRole("link", { name: "DSG-26-0001" });
    expect(docLink.getAttribute("href")).toBe("/disaggregation/d1");
  });
});
