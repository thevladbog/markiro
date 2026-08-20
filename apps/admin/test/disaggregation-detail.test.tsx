import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { DisaggregationDocumentPage } from "../src/pages/disaggregation/DocumentDetail.js";

const ACCESS_WRITE: AccessDocument = {
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

const REASONS = { items: [{ id: "r1", name: "Брак", sortOrder: 1 }] };

const LINE_OK_1 = {
  id: "l1",
  ssccInput: "100000000000000008",
  sscc: "00100000000000000008",
  boxId: "b1",
  status: "ok",
  productId: "p1",
  productName: "Вода 0.5",
  codeCount: 12,
  validatedAt: "2026-08-20T08:01:00.000Z",
};

const LINE_OK_2 = {
  id: "l2",
  ssccInput: "200000000000000007",
  sscc: "00200000000000000007",
  boxId: "b2",
  status: "ok",
  productId: "p2",
  productName: "Вода 1.5",
  codeCount: 12,
  validatedAt: "2026-08-20T08:02:00.000Z",
};

const LINE_WRITTEN_OFF = { ...LINE_OK_2, status: "written_off" };

const DOC_DRAFT_READY = {
  id: "d1",
  docNo: "DSG-26-0001",
  status: "draft",
  reasonId: "r1",
  reasonName: "Брак",
  comment: null,
  source: "manual",
  lineCount: 2,
  codeCount: 24,
  createdByUserId: "u1",
  createdAt: "2026-08-20T08:00:00.000Z",
  appliedAt: null,
  appliedByUserId: null,
  cancelledAt: null,
  lines: [LINE_OK_1, LINE_OK_2],
};

const DOC_APPLIED = {
  id: "d1",
  docNo: "DSG-26-0002",
  status: "applied",
  reasonId: "r1",
  reasonName: "Брак",
  comment: "Партия повреждена",
  source: "manual",
  lineCount: 2,
  codeCount: 24,
  createdByUserId: "u1",
  createdAt: "2026-08-19T08:00:00.000Z",
  appliedAt: "2026-08-19T09:00:00.000Z",
  appliedByUserId: "u1",
  cancelledAt: null,
  lines: [LINE_OK_1, LINE_OK_2],
};

function stubFetch(doc: unknown) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith("/api/disaggregation-reasons")) {
      return jsonResponse(200, REASONS);
    }
    if (/^\/api\/disaggregation\/d1\/lines\/[^/]+$/.test(path) && init?.method === "DELETE") {
      return jsonResponse(204, undefined);
    }
    if (path === "/api/disaggregation/d1") {
      return jsonResponse(200, doc);
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Like `stubFetch`, but also wires up `POST /api/disaggregation/d1/apply`
 * (using `applyResponse` verbatim -- pass a non-2xx `status` to exercise the
 * 409 `invalid_lines` path) and lets the GET response change on refetch
 * (`docAfter`, returned starting from the 2nd `GET /api/disaggregation/d1`)
 * so a post-apply query invalidation can be observed picking up fresh line
 * statuses.
 */
function stubFetchWithApply(options: {
  doc: unknown;
  applyResponse: { status: number; body: unknown };
  docAfter?: unknown;
}) {
  let getCount = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith("/api/disaggregation-reasons")) {
      return jsonResponse(200, REASONS);
    }
    if (path === "/api/disaggregation/d1/apply" && init?.method === "POST") {
      return jsonResponse(options.applyResponse.status, options.applyResponse.body);
    }
    if (/^\/api\/disaggregation\/d1\/lines\/[^/]+$/.test(path) && init?.method === "DELETE") {
      return jsonResponse(204, undefined);
    }
    if (path === "/api/disaggregation/d1") {
      getCount += 1;
      const body = getCount === 1 ? options.doc : (options.docAfter ?? options.doc);
      return jsonResponse(200, body);
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, getCount: () => getCount };
}

function renderPage(doc: unknown, access: AccessDocument = ACCESS_WRITE) {
  const fetchMock = stubFetch(doc);
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/disaggregation/:id" element={<DisaggregationDocumentPage />} />,
    ),
    { initialEntries: ["/disaggregation/d1"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup(), fetchMock };
}

function renderPageWithApply(
  options: { doc: unknown; applyResponse: { status: number; body: unknown }; docAfter?: unknown },
  access: AccessDocument = ACCESS_WRITE,
) {
  const { fetchMock, getCount } = stubFetchWithApply(options);
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/disaggregation/:id" element={<DisaggregationDocumentPage />} />,
    ),
    { initialEntries: ["/disaggregation/d1"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup(), fetchMock, getCount };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DisaggregationDocumentPage", () => {
  it("renders draft lines with per-status chips and enables Apply when all-ok with a reason", async () => {
    renderPage(DOC_DRAFT_READY);

    expect(await screen.findByText("DSG-26-0001")).toBeTruthy();
    expect(screen.getByText("Вода 0.5")).toBeTruthy();
    expect(screen.getByText("Вода 1.5")).toBeTruthy();
    expect(screen.getAllByText("Готов к проведению")).toHaveLength(2);

    const applyButton = screen.getByRole("button", { name: "Провести" });
    expect(applyButton.hasAttribute("disabled")).toBe(false);
  });

  it("disables Apply when a line is written_off or the reason is missing", async () => {
    renderPage({ ...DOC_DRAFT_READY, lines: [LINE_OK_1, LINE_WRITTEN_OFF] });

    await screen.findByText("DSG-26-0001");
    expect(screen.getByText("Списан/выдан через киоск")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Провести" }).hasAttribute("disabled")).toBe(true);

    cleanup();

    renderPage({ ...DOC_DRAFT_READY, reasonId: null, reasonName: null });
    await screen.findByText("DSG-26-0001");
    expect(screen.getByRole("button", { name: "Провести" }).hasAttribute("disabled")).toBe(true);
  });

  it("deletes a line via DELETE /api/disaggregation/d1/lines/l1", async () => {
    const { fetchMock, user } = renderPage(DOC_DRAFT_READY);

    await screen.findByText("DSG-26-0001");
    const deleteButtons = screen.getAllByRole("button", { name: "Удалить" });
    await user.click(deleteButtons[0]!);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/disaggregation/d1/lines/l1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("renders applied documents read-only, with no add panel or Apply button", async () => {
    renderPage(DOC_APPLIED);

    expect(await screen.findByText("DSG-26-0002")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Провести" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить строки" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  });

  it("applies the document: confirming posts /apply and closes the dialog", async () => {
    const { fetchMock, user } = renderPageWithApply({
      doc: DOC_DRAFT_READY,
      applyResponse: { status: 200, body: { ...DOC_DRAFT_READY, status: "applied" } },
    });

    await screen.findByText("DSG-26-0001");
    await user.click(screen.getByRole("button", { name: "Провести" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/24/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Провести" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/disaggregation/d1/apply",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(await screen.findByText("Документ проведён")).toBeTruthy();
  });

  it("shows applyBlocked on a 409 invalid_lines response and refetches the document", async () => {
    const docAfter = { ...DOC_DRAFT_READY, lines: [LINE_OK_1, LINE_WRITTEN_OFF] };
    const { fetchMock, user, getCount } = renderPageWithApply({
      doc: DOC_DRAFT_READY,
      applyResponse: { status: 409, body: { code: "invalid_lines", message: "Invalid lines" } },
      docAfter,
    });

    await screen.findByText("DSG-26-0001");
    await user.click(screen.getByRole("button", { name: "Провести" }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Провести" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/disaggregation/d1/apply",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(
      await screen.findByText("Часть строк изменила статус и не готова к проведению. Проверьте таблицу ниже."),
    ).toBeTruthy();

    await waitFor(() => expect(getCount()).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Списан/выдан через киоск")).toBeTruthy();
  });
});
