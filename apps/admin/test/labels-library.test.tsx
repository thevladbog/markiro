/**
 * Plan 04 Task 8: admin label template library screen.
 *
 * Mirrors the established list-screen test pattern (see
 * `counterparties.test.tsx`): TanStack Query hooks over a stubbed `fetch`,
 * asserting the Spinner-on-pending / Alert-on-error / EmptyState-on-empty /
 * cards-on-success states. Two extra concerns specific to this screen:
 *
 *  - Summaries from `GET /label-templates` carry no `spec` (see
 *    `apps/admin/src/pages/labels/api.ts`'s doc comment); each card's
 *    thumbnail lazily fetches its OWN full template via `GET
 *    /label-templates/:id` (`useLabelTemplate`), so the fetch mock below
 *    must answer both endpoints.
 *  - `TemplateThumb`'s canvas draw is a no-op under jsdom (`getContext("2d")`
 *    returns `null` there -- same constraint `labels-canvas.test.tsx`
 *    documents for `LabelCanvas`), so the "renders without crashing" case is
 *    just: the page renders, and a `<canvas>` element exists in the DOM.
 *
 * Needs a `MemoryRouter` (not just `QueryClientProvider`): every card and
 * the "+ Новый шаблон" tile are real `<Link>`s (see `index.tsx`'s doc
 * comment on why a styled `<Link>` is used instead of nesting a `<button>`
 * inside an `<a>`), which `react-router`'s hooks require a router context for.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LabelTemplateSpec } from "@markiro/domain";

import { LabelTemplatesPage } from "../src/pages/labels/index.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/labels"]}>
        <LabelTemplatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SAMPLE_SPEC: LabelTemplateSpec = {
  widthMm: 100,
  heightMm: 100,
  dpi: 203,
  language: "zpl",
  elements: [{ kind: "text", id: "t1", xMm: 5, yMm: 5, text: "Hello", fontSizePt: 12 }],
};

const BOX_SUMMARY = {
  id: "tpl-1",
  name: "Короб 100×100 v3",
  widthMm: 100,
  heightMm: 100,
  dpi: 203 as const,
  language: "zpl" as const,
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const UNIT_SUMMARY = {
  id: "tpl-2",
  name: "Единица 58×40",
  widthMm: 58,
  heightMm: 40,
  dpi: 203 as const,
  language: "tspl" as const,
  updatedAt: "2026-07-02T00:00:00.000Z",
};

/** Answers both `GET /label-templates` (list) and `GET /label-templates/:id` (per-card thumbnail). */
function stubFetch(
  items: Array<typeof BOX_SUMMARY | typeof UNIT_SUMMARY>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/label-templates") {
      return jsonResponse(200, { items });
    }
    const match = /^\/api\/label-templates\/(.+)$/.exec(url);
    if (match) {
      const summary = items.find((item) => item.id === match[1]);
      if (!summary) return jsonResponse(404, { message: "Not found" });
      return jsonResponse(200, {
        id: summary.id,
        name: summary.name,
        spec: SAMPLE_SPEC,
        createdAt: summary.updatedAt,
        updatedAt: summary.updatedAt,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LabelTemplatesPage", () => {
  it("renders cards from the mocked GET response with name and size/DPI/language badges", async () => {
    stubFetch([BOX_SUMMARY, UNIT_SUMMARY]);

    renderPage();

    expect(await screen.findByText("Короб 100×100 v3")).toBeDefined();
    expect(screen.getByText("Единица 58×40")).toBeDefined();
    expect(screen.getByText("100×100 мм")).toBeDefined();
    expect(screen.getByText("58×40 мм")).toBeDefined();
    expect(screen.getAllByText("203 dpi")).toHaveLength(2);
    expect(screen.getByText("ZPL")).toBeDefined();
    expect(screen.getByText("TSPL")).toBeDefined();
  });

  it("renders a thumbnail <canvas> per card without crashing under jsdom's ctx-less canvas", async () => {
    stubFetch([BOX_SUMMARY]);

    const { container } = renderPage();
    await screen.findByText("Короб 100×100 v3");

    const canvases = container.querySelectorAll("canvas");
    expect(canvases).toHaveLength(1);
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Шаблоны не созданы")).toBeNull();
  });

  it("shows EmptyState with a create-template CTA when the list is empty", async () => {
    stubFetch([]);

    renderPage();

    expect(await screen.findByText("Шаблоны не созданы")).toBeDefined();
    const ctas = screen.getAllByRole("link", { name: "+ Шаблон" });
    expect(ctas.some((cta) => cta.getAttribute("href") === "/labels/new")).toBe(true);
  });

  it("shows an error alert (not EmptyState) when the list request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { message: "Internal error" })),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Шаблоны не созданы")).toBeNull();
  });

  it("the '+ Новый шаблон' card is a real link to /labels/new (route lands in a later task)", async () => {
    stubFetch([BOX_SUMMARY]);

    renderPage();
    await screen.findByText("Короб 100×100 v3");

    const newTemplateCard = screen.getByRole("link", { name: "+ Новый шаблон" });
    expect(newTemplateCard.getAttribute("href")).toBe("/labels/new");
  });

  it("each card links to its own editor route", async () => {
    stubFetch([BOX_SUMMARY]);

    renderPage();
    const cardLink = await screen.findByRole("link", { name: /Короб 100×100 v3/ });
    expect(cardLink.getAttribute("href")).toBe("/labels/tpl-1");
  });
});
