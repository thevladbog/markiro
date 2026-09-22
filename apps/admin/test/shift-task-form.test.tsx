/**
 * Task 7: the printable A4 shift task form button in the admin shift card.
 * Mirrors `apps/admin/test/inventory-task-form.test.tsx` -- the inventory
 * task-form button is the direct analogue. This is a read operation (an
 * operator prints a work order, does not change anything), so it must not be
 * gated on `CABINET_CAPABILITY.OPERATIONS_WRITE`: the test renders with only
 * `OPERATIONS_READ` to prove that.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { ShiftDetailsPanel } from "../src/pages/shifts/ShiftDetailsPanel.js";
import type { ShiftDto, ShiftStatus } from "../src/pages/shifts/api.js";

const SHIFT_ID = "11111111-1111-4111-8111-111111111111";

const SHIFT: ShiftDto = {
  validationPrint: {
    mode: "none",
    verification: "none",
    templateId: null,
    snapshot: null,
    policyRevision: null,
  },
  id: SHIFT_ID,
  number: "SEP26-001",
  status: "planned",
  mode: "aggregation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: null,
  lineName: "Линия розлива № 1",
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  palletLabelTemplateId: null,
  plannedQty: 480,
  plannedDate: "2026-09-11",
  productionDate: null,
  boxCapacity: 12,
  palletBoxCapacity: null,
  palletsEnabled: false,
  createdFrom: "admin",
  openedAt: null,
  closedAt: null,
  lateDataAt: null,
  closeReason: null,
  createdAt: "2026-09-11T05:00:00.000Z",
  output: { mode: "aggregation", closedBoxes: 0, containedUnits: 0 },
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel({ status }: { status: ShiftStatus }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/shifts/${SHIFT_ID}/summary`) {
        return response({
          generatedAt: "2026-09-11T16:05:00.000Z",
          output: { mode: "aggregation", closedBoxes: 0, containedUnits: 0 },
          participants: [],
          unattributed: { eventCount: 0, acceptedScans: 0, closedBoxes: 0 },
        });
      }
      if (url === "/api/shift-exports/formats") return response([]);
      if (url === `/api/shifts/${SHIFT_ID}/exports`) return response([]);
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
          <MemoryRouter>
            <ShiftDetailsPanel shift={{ ...SHIFT, status }} onClose={() => undefined} />
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

it("opens the printable shift task form in a new tab for a read-only administrator", async () => {
  const openMock = vi.fn();
  vi.stubGlobal("open", openMock);
  const user = renderPanel({ status: "planned" });

  const action = await screen.findByRole("button", { name: "Открыть бланк смены" });
  expect(action.hasAttribute("disabled")).toBe(false);

  await user.click(action);
  expect(openMock).toHaveBeenCalledWith(
    `/api/shifts/${SHIFT_ID}/task-form`,
    "_blank",
    "noopener,noreferrer",
  );
});

it("offers the form for an active shift too, because one sheet lives the whole shift", async () => {
  renderPanel({ status: "active" });
  expect(await screen.findByRole("button", { name: "Открыть бланк смены" })).toBeDefined();
});

it("hides the form for a closed shift, whose barcode no terminal would accept", async () => {
  renderPanel({ status: "closed" });
  await screen.findByText("Параметры смены");
  expect(screen.queryByRole("button", { name: "Открыть бланк смены" })).toBeNull();
});

it("localizes the action in English", async () => {
  await i18n.changeLanguage("en");
  renderPanel({ status: "planned" });
  expect(await screen.findByRole("button", { name: "Open shift form" })).toBeDefined();
});
