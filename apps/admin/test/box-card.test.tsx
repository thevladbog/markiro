import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { BoxCardPage } from "../src/pages/code-search/BoxCard.js";

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

const BOX_CARD = {
  id: "b1",
  sscc: "00000000000000000001",
  status: "disassembled" as const,
  shiftId: "sh1",
  productId: "p1",
  productName: "Молоко 1л",
  terminalId: "t1",
  operatorId: "op1",
  openedAt: "2026-08-20T08:00:00.000Z",
  closedAt: "2026-08-20T08:30:00.000Z",
  disassembledAt: "2026-08-20T09:00:00.000Z",
  items: [
    {
      codeHash: "a".repeat(64),
      gtin14: "04630000000001",
      serial: "SN0001",
      // Full wire form incl. the GS-separated (U+001D) crypto tail.
      rawKm: "010463000000000121SN0001\u001d93dGVz",
      addedAt: "2026-08-20T08:05:00.000Z",
      displacedAt: null,
      removedAt: null,
    },
    {
      codeHash: "b".repeat(64),
      gtin14: "04630000000001",
      serial: "SN0002",
      rawKm: null,
      addedAt: "2026-08-20T08:06:00.000Z",
      displacedAt: null,
      removedAt: "2026-08-20T08:40:00.000Z",
    },
  ],
  exceptions: [
    {
      kind: "disassemble",
      reason: "damaged",
      occurredAt: "2026-08-20T09:00:00.000Z",
      operatorId: "op1",
      disaggregationDocumentId: "d1",
      disaggregationDocNo: "DSG-26-0001",
    },
  ],
  pickupOrders: [{ orderId: "o1", orderNo: "PU-26-0001", status: "punched" }],
};

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/api/code-search/boxes/")) {
      return jsonResponse(200, BOX_CARD);
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
        <Route path="/codes/box/:boxId" element={<BoxCardPage />} />
        <Route path="/codes/km/:codeHash" element={<div>Code card stub</div>} />
        <Route path="/disaggregation/:id" element={<div>Doc stub</div>} />
        <Route path="/pickup/:id" element={<div>Order stub</div>} />
      </>,
    ),
    { initialEntries: [`/codes/box/${BOX_CARD.id}`] },
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

describe("BoxCardPage", () => {
  it("renders 2 items with the removed row badged, and the disassemble exception with its DSG number", async () => {
    stubFetch();
    renderPage();

    expect(await screen.findByText("Молоко 1л")).toBeTruthy();

    // Both code rows render, linking to their code cards. The first row has
    // the full stored KM, so it shows the crypto tail with the GS control
    // char made visible; the second (no rawKm) falls back to `01…21…`.
    const codeLink1 = screen.getByRole("link", { name: "010463000000000121SN0001␝93dGVz" });
    expect(codeLink1.getAttribute("href")).toBe(`/codes/km/${BOX_CARD.items[0]!.codeHash}`);
    const codeLink2 = screen.getByRole("link", { name: "010463000000000121SN0002" });
    expect(codeLink2.getAttribute("href")).toBe(`/codes/km/${BOX_CARD.items[1]!.codeHash}`);

    // The removed row is badged.
    expect(screen.getByText("Убран")).toBeTruthy();

    // The disassemble exception shows its document number, linked.
    const docLink = screen.getByRole("link", { name: "DSG-26-0001" });
    expect(docLink.getAttribute("href")).toBe("/disaggregation/d1");

    // The pickup order links to the order detail.
    const orderLink = screen.getByRole("link", { name: "PU-26-0001" });
    expect(orderLink.getAttribute("href")).toBe("/pickup/o1");
  });

  it("opens the print-ready box report in a new tab", async () => {
    stubFetch();
    const openMock = vi.fn();
    vi.stubGlobal("open", openMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Распечатать" }));
    expect(openMock).toHaveBeenCalledWith(`/api/code-search/boxes/${BOX_CARD.id}/report`);
  });

  it("offers a back link to the code registry", async () => {
    stubFetch();
    renderPage();

    const backLink = await screen.findByRole("link", { name: "← Поиск кодов" });
    expect(backLink.getAttribute("href")).toBe("/codes");
  });
});
