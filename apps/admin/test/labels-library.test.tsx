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
 *    returns `null` there -- same constraint `labels-geometry.test.ts`
 *    documents for the shared `renderer.ts`), so the "renders without
 *    crashing" case is just: the page renders, and a `<canvas>` element
 *    exists in the DOM.
 *
 * Needs a `MemoryRouter` (not just `QueryClientProvider`): every card and
 * the "+ Новый шаблон" tile are real `<Link>`s (see `index.tsx`'s doc
 * comment on why a styled `<Link>` is used instead of nesting a `<button>`
 * inside an `<a>`), which `react-router`'s hooks require a router context for.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY, type LabelTemplateSpec } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
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
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_WRITE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

function renderPage(access: AccessDocument = OPERATIONS_WRITE_ACCESS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/labels"]}>
        <AccessProvider value={access}>
          <LabelTemplatesPage />
        </AccessProvider>
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
  enabled: true,
  chzProductGroupCodes: null as number[] | null,
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const UNIT_SUMMARY = {
  id: "tpl-2",
  name: "Единица 58×40",
  widthMm: 58,
  heightMm: 40,
  dpi: 203 as const,
  language: "tspl" as const,
  enabled: true,
  chzProductGroupCodes: null as number[] | null,
  updatedAt: "2026-07-02T00:00:00.000Z",
};

const BEER_SUMMARY = {
  id: "tpl-3",
  name: "Пиво 58×40",
  widthMm: 58,
  heightMm: 40,
  dpi: 203 as const,
  language: "zpl" as const,
  enabled: false,
  chzProductGroupCodes: [15] as number[] | null,
  updatedAt: "2026-07-03T00:00:00.000Z",
};

type Summary = typeof BOX_SUMMARY | typeof UNIT_SUMMARY | typeof BEER_SUMMARY;

/** Answers the library list (`enabled=all`), the product-group dictionary, `GET /label-templates/:id` (per-card thumbnail) and the card toggle PATCH. */
function stubFetch(items: Summary[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/label-templates?enabled=all") {
      return jsonResponse(200, { items });
    }
    if (url === "/api/chz-product-groups") {
      return jsonResponse(200, { items: [{ code: 15, alias: "beer", name: "Пиво" }] });
    }
    if (/^\/api\/label-templates\/[^/?]+$/.test(url) && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as { enabled?: boolean };
      const id = url.slice("/api/label-templates/".length);
      const summary = items.find((item) => item.id === id);
      if (!summary) return jsonResponse(404, { message: "Not found" });
      return jsonResponse(200, {
        ...summary,
        spec: SAMPLE_SPEC,
        enabled: body.enabled ?? summary.enabled,
      });
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
  it("keeps template cards readable but removes editor links without operations.write", async () => {
    stubFetch([BOX_SUMMARY]);

    renderPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(BOX_SUMMARY.name)).toBeDefined();
    expect(screen.queryByRole("link", { name: "+ Новый шаблон" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Короб 100×100 v3/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Новый шаблон" })).toBeNull();
  });

  it("renders cards from the mocked GET response with name and size/DPI badges", async () => {
    stubFetch([BOX_SUMMARY, UNIT_SUMMARY]);

    renderPage();

    expect(await screen.findByText("Короб 100×100 v3")).toBeDefined();
    expect(screen.getByText("Единица 58×40")).toBeDefined();
    expect(screen.getByText("100.0×100.0 мм")).toBeDefined();
    expect(screen.getByText("58.0×40.0 мм")).toBeDefined();
    expect(screen.getAllByText("203 dpi")).toHaveLength(2);
    // A template is language-neutral -- it prints on Zebra and TSC alike and
    // the station picks the language from its own printer, so no card may
    // badge one. `language` is still on the summary DTO (these two fixtures
    // deliberately differ) -- it just must not reach the screen.
    expect(screen.queryByText("ZPL")).toBeNull();
    expect(screen.queryByText("TSPL")).toBeNull();
  });

  it("rounds imported label dimensions to one decimal place in the card badge", async () => {
    stubFetch([
      {
        ...UNIT_SUMMARY,
        widthMm: 57.99666666666667,
        heightMm: 39.962666666666664,
      },
    ]);

    renderPage();

    expect(await screen.findByText("58.0×40.0 мм")).toBeDefined();
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
  it("shows scope and disabled badges and filters by state", async () => {
    stubFetch([BOX_SUMMARY, BEER_SUMMARY]);
    renderPage();
    await screen.findByText("Короб 100×100 v3");
    expect(screen.getAllByText("Все категории")).toHaveLength(1);
    expect(await screen.findByText("Пиво")).toBeDefined();
    expect(screen.getByText("Выключен")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Выключенные" }));
    expect(screen.queryByText("Короб 100×100 v3")).toBeNull();
    expect(screen.getByText("Пиво 58×40")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Включённые" }));
    expect(screen.getByText("Короб 100×100 v3")).toBeDefined();
    expect(screen.queryByText("Пиво 58×40")).toBeNull();
  });

  it("toggles a template from the card and reports a default conflict", async () => {
    const fetchMock = stubFetch([BOX_SUMMARY, BEER_SUMMARY]);
    renderPage();
    await screen.findByText("Пиво 58×40");
    fireEvent.click(screen.getByRole("button", { name: "Включить" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/label-templates/tpl-3",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }),
      ),
    );
    expect(await screen.findByText("Шаблон включён")).toBeDefined();

    // A 409 on disable explains where the template is a default.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/label-templates/tpl-1" && init?.method === "PATCH") {
          return jsonResponse(409, {
            code: "LABEL_TEMPLATE_IS_DEFAULT",
            message: "default",
            organizationDefault: true,
            categoryDefaults: [15],
          });
        }
        return fetchMock(url, init);
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Выключить" })[0]!);
    expect(
      await screen.findByText(
        "Шаблон назначен дефолтом организации. Шаблон назначен дефолтом категорий: Пиво. Сначала выберите другой шаблон в настройках организации.",
      ),
    ).toBeDefined();
  });

  it("hides the toggle from read-only users", async () => {
    stubFetch([BOX_SUMMARY]);
    renderPage(OPERATIONS_READ_ONLY);
    await screen.findByText("Короб 100×100 v3");
    expect(screen.queryByRole("button", { name: "Выключить" })).toBeNull();
  });
});
