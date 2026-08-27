import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { DisaggregationPage } from "../src/pages/disaggregation/index.js";

const ACCESS_WRITE: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const ACCESS_READ_ONLY: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function renderPage(access: AccessDocument = ACCESS_WRITE) {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <>
        <Route path="/disaggregation" element={<DisaggregationPage />} />
        <Route path="/disaggregation/:id" element={<div>Document detail stub</div>} />
      </>,
    ),
    { initialEntries: ["/disaggregation"] },
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
  return { router, user: userEvent.setup() };
}

const DOC_DRAFT = {
  id: "d1",
  docNo: "DSG-26-0001",
  status: "draft",
  reasonId: null,
  reasonName: null,
  comment: null,
  source: "manual",
  lineCount: 2,
  codeCount: 24,
  createdByUserId: "u1",
  createdAt: "2026-08-20T08:00:00.000Z",
  appliedAt: null,
  appliedByUserId: null,
  cancelledAt: null,
};

const DOC_APPLIED = {
  id: "d2",
  docNo: "DSG-26-0002",
  status: "applied",
  reasonId: "r1",
  reasonName: "Брак",
  comment: null,
  source: "import",
  lineCount: 1,
  codeCount: 12,
  createdByUserId: "u1",
  createdAt: "2026-08-19T08:00:00.000Z",
  appliedAt: "2026-08-19T09:00:00.000Z",
  appliedByUserId: "u1",
  cancelledAt: null,
};

function stubFetch(handlers: {
  "/api/disaggregation"?: unknown;
  "/api/disaggregation-reasons"?: unknown;
  post?: unknown;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith("/api/disaggregation-reasons")) {
      return jsonResponse(200, handlers["/api/disaggregation-reasons"] ?? { items: [] });
    }
    if (path.startsWith("/api/disaggregation") && init?.method === "POST") {
      return jsonResponse(201, handlers.post ?? DOC_DRAFT);
    }
    if (path.startsWith("/api/disaggregation")) {
      return jsonResponse(
        200,
        handlers["/api/disaggregation"] ?? { items: [], page: 1, pageCount: 1, total: 0 },
      );
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DisaggregationPage", () => {
  it("renders the document list with status chips", async () => {
    stubFetch({
      "/api/disaggregation": {
        items: [DOC_DRAFT, DOC_APPLIED],
        page: 1,
        pageCount: 1,
        total: 2,
      },
    });

    renderPage();

    expect(await screen.findByText("DSG-26-0001")).toBeTruthy();
    expect(screen.getByText("DSG-26-0002")).toBeTruthy();
    expect(screen.getByText("Брак")).toBeTruthy();
  });

  it("create button posts a draft and navigates to it", async () => {
    const fetchMock = stubFetch({
      "/api/disaggregation": { items: [], page: 1, pageCount: 1, total: 0 },
      post: { ...DOC_DRAFT, id: "d9" },
    });
    const { router, user } = renderPage();

    await screen.findByText("Дезагрегация");
    await user.click(screen.getByRole("button", { name: "Создать документ" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/disaggregation",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/disaggregation/d9"));
  });

  it("hides the create button without OPERATIONS_WRITE", async () => {
    stubFetch({ "/api/disaggregation": { items: [], page: 1, pageCount: 1, total: 0 } });

    renderPage(ACCESS_READ_ONLY);

    await screen.findByText("Дезагрегация");
    expect(screen.queryByRole("button", { name: "Создать документ" })).toBeNull();
  });

  it("shows the empty state when there are no documents", async () => {
    stubFetch({ "/api/disaggregation": { items: [], page: 1, pageCount: 1, total: 0 } });

    renderPage();

    expect(await screen.findByText("Документы не найдены")).toBeTruthy();
  });
});
