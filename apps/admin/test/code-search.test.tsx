import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { CodeSearchPage } from "../src/pages/code-search/index.js";

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
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function renderPage() {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <>
        <Route path="/codes" element={<CodeSearchPage />} />
        <Route path="/codes/km/:codeHash" element={<div>Code card stub</div>} />
        <Route path="/codes/box/:boxId" element={<div>Box card stub</div>} />
      </>,
    ),
    { initialEntries: ["/codes"] },
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
  return { router, user: userEvent.setup() };
}

const CODE_ITEM = {
  codeHash: "a".repeat(64),
  gtin14: "04630000000001",
  serial: "SN0001",
  productId: "p1",
  productName: "Молоко 1л",
  status: "free" as const,
  scannedAt: "2026-08-20T08:00:00.000Z",
  boxId: null,
  boxSscc: null,
};

const CODE_ITEM_AGGREGATED = {
  ...CODE_ITEM,
  codeHash: "b".repeat(64),
  serial: "SN0002",
  status: "aggregated" as const,
  boxId: "b1",
  boxSscc: "000000000000000001",
};

function stubFetch(handlers: {
  list?: unknown;
  products?: unknown;
  classify?: { status: number; body: unknown };
}) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/api/code-search/codes")) {
      return jsonResponse(200, handlers.list ?? { items: [], page: 1, pageCount: 1, total: 0 });
    }
    if (path.startsWith("/api/code-search?")) {
      const classify = handlers.classify ?? { status: 404, body: { code: "unrecognized" } };
      return jsonResponse(classify.status, classify.body);
    }
    if (path.startsWith("/api/products")) {
      return jsonResponse(200, handlers.products ?? { items: [] });
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

describe("CodeSearchPage", () => {
  it("renders registry rows with status chips", async () => {
    stubFetch({
      list: { items: [CODE_ITEM, CODE_ITEM_AGGREGATED], page: 1, pageCount: 1, total: 2 },
    });

    renderPage();

    expect((await screen.findAllByText("Молоко 1л")).length).toBe(2);
    expect(await screen.findByText("010463000000000121SN0001")).toBeTruthy();
    expect(screen.getByText("010463000000000121SN0002")).toBeTruthy();
  });

  it("submitting an SSCC navigates to the box card", async () => {
    stubFetch({
      list: { items: [], page: 1, pageCount: 1, total: 0 },
      classify: { status: 200, body: { type: "box", boxId: "b1" } },
    });
    const { router, user } = renderPage();

    await screen.findByText("Поиск кодов");
    const input = screen.getByPlaceholderText(
      "Введите SSCC (можно часть номера) или код маркировки",
    );
    await user.type(input, "000000000000000001");
    await user.click(screen.getByRole("button", { name: "Найти" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/codes/box/b1"));
  });

  it("shows a pick-one list when a partial SSCC matches several boxes", async () => {
    stubFetch({
      list: { items: [], page: 1, pageCount: 1, total: 0 },
      classify: {
        status: 200,
        body: {
          type: "boxes",
          items: [
            {
              boxId: "b1",
              sscc: "00123456789012345675",
              productName: "Молоко 1л",
              closedAt: "2026-08-20T08:30:00.000Z",
            },
            {
              boxId: "b2",
              sscc: "00123456789012345682",
              productName: null,
              closedAt: null,
            },
          ],
        },
      },
    });
    const { router, user } = renderPage();

    await screen.findByText("Поиск кодов");
    const input = screen.getByPlaceholderText(
      "Введите SSCC (можно часть номера) или код маркировки",
    );
    await user.type(input, "3456");
    await user.click(screen.getByRole("button", { name: "Найти" }));

    expect(await screen.findByText("Найдено несколько коробов — выберите нужный:")).toBeTruthy();
    const boxLink = screen.getByRole("link", { name: "(00)123456789012345675" });
    expect(boxLink.getAttribute("href")).toBe("/codes/box/b1");
    expect(screen.getByRole("link", { name: "(00)123456789012345682" }).getAttribute("href")).toBe(
      "/codes/box/b2",
    );
    // No navigation happened -- the manager picks from the list.
    expect(router.state.location.pathname).toBe("/codes");

    await user.click(boxLink);
    await waitFor(() => expect(router.state.location.pathname).toBe("/codes/box/b1"));
  });

  it("shows an inline alert for an unrecognized query", async () => {
    stubFetch({
      list: { items: [], page: 1, pageCount: 1, total: 0 },
      classify: { status: 404, body: { code: "unrecognized" } },
    });
    const { user } = renderPage();

    await screen.findByText("Поиск кодов");
    const input = screen.getByPlaceholderText(
      "Введите SSCC (можно часть номера) или код маркировки",
    );
    await user.type(input, "not-a-code");
    await user.click(screen.getByRole("button", { name: "Найти" }));

    expect(await screen.findByText("Код не распознан")).toBeTruthy();
  });

  it("shows an inline alert for a well-formed but unknown code", async () => {
    stubFetch({
      list: { items: [], page: 1, pageCount: 1, total: 0 },
      classify: { status: 404, body: { code: "not_found" } },
    });
    const { user } = renderPage();

    await screen.findByText("Поиск кодов");
    const input = screen.getByPlaceholderText(
      "Введите SSCC (можно часть номера) или код маркировки",
    );
    await user.type(input, "000000000000000001");
    await user.click(screen.getByRole("button", { name: "Найти" }));

    expect(await screen.findByText("Ничего не найдено по этому запросу")).toBeTruthy();
  });

  it("shows the generic failure alert for a server error, not the notFound copy", async () => {
    stubFetch({
      list: { items: [], page: 1, pageCount: 1, total: 0 },
      classify: { status: 500, body: { message: "Internal error" } },
    });
    const { user } = renderPage();

    await screen.findByText("Поиск кодов");
    const input = screen.getByPlaceholderText(
      "Введите SSCC (можно часть номера) или код маркировки",
    );
    await user.type(input, "000000000000000001");
    await user.click(screen.getByRole("button", { name: "Найти" }));

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeTruthy();
    expect(screen.queryByText("Ничего не найдено по этому запросу")).toBeNull();
    expect(screen.queryByText("Код не распознан")).toBeNull();
  });
});
