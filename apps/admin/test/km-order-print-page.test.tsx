/**
 * The page a print batch actually opens: one physical label per marking
 * code, on its own page, sized from the label template.
 *
 * jsdom's `canvas.getContext("2d")` is `null` (the optional native `canvas`
 * package is deliberately not a dependency -- see `labels/rasterizer.ts`),
 * so NOTHING here proves a label's pixels. What it does prove is the page's
 * structure, the `@page` rule the browser sizes the media from, the
 * degraded per-label placeholder, the template fallback a reprint link
 * depends on, and the one property that cannot be re-checked by eye: that
 * the print dialog is opened exactly once, whatever later re-renders and
 * refetches do.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY, KM_LABEL_TEMPLATE_NAME } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { appRoutes } from "../src/app.js";
import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { KmOrderPrintPage } from "../src/pages/km-orders/KmOrderPrintPage.js";

const ID = {
  order: "11111111-1111-4111-8111-111111111111",
  product: "22222222-2222-4222-8222-222222222222",
  oms: "33333333-3333-4333-8333-333333333333",
  issue: "44444444-4444-4444-8444-444444444442",
} as const;

const TEMPLATE = {
  stock: "tpl_km_stock",
  water: "tpl_km_water",
  beer: "tpl_km_beer",
  box: "tpl_box",
} as const;

const ACCESS_WRITE: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};
const ACCESS_READ_ONLY: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

/** `Intl` groups with a no-break space, and `textContent` keeps it verbatim. */
const number = new Intl.NumberFormat("ru");

/**
 * Raw marking codes, group separator and all. They are the secret this page
 * exists to put on paper: every assertion below checks the page's chrome,
 * never a code's text, and one test pins that no request URL carries one.
 */
const CODES = [
  { seq: 1201, code: "0104680089900383215aBcD1\u001d93XyZ01" },
  { seq: 1202, code: "0104680089900383215aBcD2\u001d93XyZ02" },
  { seq: 1203, code: "0104680089900383215aBcD3\u001d93XyZ03" },
];

/**
 * A batch of the same shape and any size. The "code" is an index, never a
 * real marking code -- these fixtures exist to count canvases, not to be
 * scanned.
 */
function manyCodes(count: number): Array<{ seq: number; code: string }> {
  return Array.from({ length: count }, (_, index) => ({
    seq: 1201 + index,
    code: `010468008990038321TEST${String(index).padStart(4, "0")}93XyZ0`,
  }));
}

const SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      kind: "field",
      id: "name",
      xMm: 2,
      yMm: 2,
      field: "product.printName",
      fontSizePt: 8,
      maxWidthMm: 54,
    },
    {
      kind: "barcode",
      id: "km",
      xMm: 4,
      yMm: 10,
      format: "datamatrix",
      data: "km.code",
      sizeMm: 0.4,
    },
  ],
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.order,
    productId: ID.product,
    productName: "Вода газированная 1,0 л",
    gtin14: "04680089900383",
    productGroupAlias: "water",
    templateId: 16,
    quantity: 5000,
    state: "completed",
    omsOrderId: ID.oms,
    bufferStatus: "ACTIVE",
    bufferExpiresAt: null,
    availableCodes: 0,
    fetchedCount: 5000,
    issuedCount: 1203,
    availableForIssue: 3797,
    rejectionReason: null,
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    createdBy: { id: "user_1", name: "Елена Ким" },
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
    issues: [
      {
        id: ID.issue,
        kind: "print",
        format: null,
        fromSeq: 1201,
        toSeq: 1203,
        count: 3,
        createdBy: { id: "user_1", name: "Елена Ким" },
        createdAt: "2026-09-02T08:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE.stock,
    name: KM_LABEL_TEMPLATE_NAME,
    purpose: "product_km",
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    enabled: true,
    chzProductGroupCodes: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Full `GET /label-templates/:id` body -- the summary plus the spec. */
function full(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE.stock,
    name: KM_LABEL_TEMPLATE_NAME,
    purpose: "product_km",
    spec: SPEC,
    enabled: true,
    chzProductGroupCodes: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const TEMPLATES = [
  summary({ id: TEMPLATE.beer, name: "КМ для пива", chzProductGroupCodes: [7] }),
  summary({ id: TEMPLATE.box, name: "Короб 100×150", purpose: "box" }),
  summary({ id: TEMPLATE.water, name: "КМ для воды", chzProductGroupCodes: [3] }),
  summary({}),
];

const GROUPS = [
  { code: 3, alias: "water", name: "Упакованная вода" },
  { code: 7, alias: "beer", name: "Пиво" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

interface RenderOptions {
  /** Appended to the print route; omitted entirely for a «Печать ещё раз». */
  template?: string | undefined;
  codes?: Array<{ seq: number; code: string }>;
  templates?: unknown[];
  templateById?: Record<string, unknown>;
  templateFails?: boolean;
  codesFail?: boolean;
  /** Answers every re-read of the order with this card, the way a poll does. */
  nextCard?: Record<string, unknown>;
}

function stubFetch(options: RenderOptions): { urls: string[] } {
  const card = order();
  const orderUrl = `/api/chz-km-orders/${String(card.id)}`;
  const urls: string[] = [];
  let cardReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === `${orderUrl}/issues/${ID.issue}/codes`) {
        return options.codesFail === true
          ? jsonResponse({ code: "INTERNAL_ERROR" }, 500)
          : jsonResponse({ codes: options.codes ?? CODES });
      }
      if (url === orderUrl) {
        cardReads += 1;
        const next = options.nextCard;
        return jsonResponse(cardReads > 1 && next !== undefined ? next : card);
      }
      if (url === "/api/label-templates?enabled=true") {
        return jsonResponse({ items: options.templates ?? TEMPLATES });
      }
      if (url === "/api/chz-product-groups") return jsonResponse({ items: GROUPS });
      if (url.startsWith("/api/label-templates/")) {
        if (options.templateFails === true) return jsonResponse({ code: "NOT_FOUND" }, 404);
        return jsonResponse(options.templateById ?? full());
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return { urls };
}

function renderPrintPage(options: RenderOptions = {}) {
  const { urls } = stubFetch(options);
  const print = vi.fn();
  vi.stubGlobal("print", print);

  const query =
    options.template === undefined ? "" : `?template=${encodeURIComponent(options.template)}`;
  const router = createMemoryRouter(
    createRoutesFromElements(
      <>
        <Route path="/km-orders/:orderId" element={<div>Карточка заказа</div>} />
        <Route path="/km-orders/:orderId/issues/:issueId/print" element={<KmOrderPrintPage />} />
      </>,
    ),
    { initialEntries: [`/km-orders/${ID.order}/issues/${ID.issue}/print${query}`] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <AccessProvider value={ACCESS_WRITE}>
          <RouterProvider router={router} />
        </AccessProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
  const view = render(tree);
  return { ...view, urls, print, router, client, tree };
}

function pages(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("section.mk-km-print__page"));
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("renders one page per code, sizes the media from the template and prints once", async () => {
  const { container, print, urls } = renderPrintPage({ template: TEMPLATE.stock });

  await waitFor(() => expect(pages(container)).toHaveLength(3));

  // Every label reports itself painted -- under jsdom through the degraded
  // placeholder path, which must not throw and must not stall the print.
  await waitFor(() =>
    expect(pages(container).every((page) => page.dataset["ready"] === "true")).toBe(true),
  );
  expect(container.querySelectorAll("img")).toHaveLength(3);

  const style = container.querySelector("style");
  expect(style?.textContent).toContain("@page { size: 58mm 40mm; margin: 0 }");
  for (const page of pages(container)) {
    expect(page.style.width).toBe("58mm");
    expect(page.style.height).toBe("40mm");
  }

  const header = container.querySelector("header.mk-km-print__screen-only");
  expect(header).not.toBeNull();
  expect(header?.querySelector("h1")?.textContent).toBe(
    `Выдача № ${number.format(1201)} – ${number.format(1203)} · 3 этикетки`,
  );

  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));

  // A marking code is a secret: it may be rendered, never addressed.
  for (const url of urls) {
    for (const { code } of CODES) expect(url).not.toContain(code);
  }
});

/**
 * Fix 1's structural property. A canvas PER LABEL is what a browser silently
 * evicts past its budget -- `getContext` still answers, `draw` still returns,
 * and the dialog opens over blank pages with the codes already spent. jsdom
 * rasterizes nothing, so memory cannot be measured here; what can be pinned
 * is that the canvas count does not follow the label count.
 */
async function canvasesForBatch(count: number): Promise<number> {
  const created: string[] = [];
  const realCreateElement = document.createElement.bind(document);
  const spy = vi
    .spyOn(document, "createElement")
    .mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      created.push(tagName);
      return realCreateElement(tagName, options);
    });
  try {
    const { container } = renderPrintPage({ template: TEMPLATE.stock, codes: manyCodes(count) });
    await waitFor(() => expect(pages(container)).toHaveLength(count));
    await waitFor(() =>
      expect(pages(container).every((page) => page.dataset["ready"] === "true")).toBe(true),
    );
  } finally {
    spy.mockRestore();
    cleanup();
  }
  return created.filter((tagName) => tagName === "canvas").length;
}

it("paints the whole batch through one canvas, whatever the label count", async () => {
  const forThree = await canvasesForBatch(3);
  const forSixty = await canvasesForBatch(60);

  expect(forThree).toBe(1);
  expect(forSixty).toBe(forThree);
});

it("says on screen how many labels could not be drawn, and captions each one", async () => {
  // Every label degrades under jsdom (no 2D context) -- the same shape an
  // enterprise policy or a canvas-fingerprinting blocker produces in a real
  // browser, where the whole batch would otherwise feed as blank stock.
  const { container, print } = renderPrintPage({ template: TEMPLATE.stock });

  await waitFor(() =>
    expect(pages(container).every((page) => page.dataset["ready"] === "true")).toBe(true),
  );

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(
    `Не удалось отрисовать ${number.format(3)} этикетки из ${number.format(3)}`,
  );
  for (const { seq } of CODES) {
    expect(screen.getByText(`Этикетку № ${String(seq)} не удалось отрисовать`)).toBeDefined();
  }

  // The dialog still opens -- the operator decides -- but never silently.
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
});

it("prints one calibration label without spending the batch or touching the server", async () => {
  const { container, print, urls } = renderPrintPage({ template: TEMPLATE.stock });

  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  const requestsBefore = urls.length;
  const scopes: string[] = [];
  print.mockImplementation(() => {
    scopes.push(container.querySelector(".mk-km-print")?.className ?? "");
  });

  fireEvent.click(screen.getByRole("button", { name: "Напечатать первую этикетку" }));

  // One page in the printed document, and it is the first label.
  expect(print).toHaveBeenCalledTimes(2);
  expect(scopes).toHaveLength(1);
  expect(scopes[0]).toContain("mk-km-print--first-only");

  // Nothing was consumed: the sheet is intact, the scope is released again,
  // and no request went out for the calibration.
  expect(pages(container)).toHaveLength(3);
  expect(container.querySelector(".mk-km-print")?.className).not.toContain("first-only");
  expect(urls).toHaveLength(requestsBefore);
});

it("sizes the media from the template it was handed, not from a fixed page", async () => {
  const { container } = renderPrintPage({
    template: TEMPLATE.box,
    templateById: full({ spec: { ...SPEC, widthMm: 100, heightMm: 150 } }),
  });

  await waitFor(() => expect(pages(container)).toHaveLength(3));

  expect(container.querySelector("style")?.textContent).toBe(
    "@page { size: 100mm 150mm; margin: 0 }",
  );
  for (const page of pages(container)) {
    expect(page.style.width).toBe("100mm");
    expect(page.style.height).toBe("150mm");
  }
});

it("keeps an unchecked template size out of the @page stylesheet text", async () => {
  // `useLabelTemplate` does not parse its response, and the `@page` rule is
  // stylesheet TEXT rather than a React-sanitised style object.
  const { container } = renderPrintPage({
    template: TEMPLATE.stock,
    templateById: full({
      spec: {
        ...SPEC,
        widthMm: "58mm } .mk-km-print__page { display: none } @page { size: 9999mm",
      },
    }),
  });

  await waitFor(() => expect(pages(container)).toHaveLength(3));

  expect(container.querySelector("style")?.textContent).toBe("@page { margin: 0 }");
});

it("opens the print dialog once, across a re-render and a refetch", async () => {
  const { container, print, client, rerender, tree } = renderPrintPage({
    template: TEMPLATE.stock,
    nextCard: order({
      issuedCount: 1500,
      availableForIssue: 3500,
      updatedAt: "2026-09-03T08:00:00.000Z",
    }),
  });

  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));

  // A plain re-render of the same tree: nothing about the page changed, so
  // nothing may reopen a dialog over a job already sent to the printer.
  rerender(tree);
  expect(print).toHaveBeenCalledTimes(1);

  // And the real one: the order card polls, so a batch left on screen gets a
  // fresh order object and every label is rebuilt from it.
  await act(async () => {
    await client.invalidateQueries();
  });
  await waitFor(() =>
    expect(pages(container).every((page) => page.dataset["ready"] === "true")).toBe(true),
  );
  expect(print).toHaveBeenCalledTimes(1);
});

it("falls back to the stock KM template when «Печать ещё раз» opens the page without one", async () => {
  const { container, urls } = renderPrintPage({});

  await waitFor(() => expect(pages(container)).toHaveLength(3));
  expect(urls).toContain(`/api/label-templates/${TEMPLATE.stock}`);
  expect(urls.some((url) => url === `/api/label-templates/${TEMPLATE.water}`)).toBe(false);
});

it("falls back to the only eligible template for the order's product group", async () => {
  const { container, urls } = renderPrintPage({
    templates: [
      summary({ id: TEMPLATE.beer, name: "КМ для пива", chzProductGroupCodes: [7] }),
      summary({ id: TEMPLATE.water, name: "КМ для воды", chzProductGroupCodes: [3] }),
    ],
    templateById: full({ id: TEMPLATE.water, name: "КМ для воды", chzProductGroupCodes: [3] }),
  });

  await waitFor(() => expect(pages(container)).toHaveLength(3));
  expect(urls).toContain(`/api/label-templates/${TEMPLATE.water}`);
});

it("explains itself instead of rendering a blank page when no template is eligible", async () => {
  const { container, print } = renderPrintPage({
    templates: [summary({ id: TEMPLATE.beer, name: "КМ для пива", chzProductGroupCodes: [7] })],
  });

  expect(await screen.findByText("Нет шаблона этикетки для этих кодов")).toBeDefined();
  expect(pages(container)).toHaveLength(0);
  expect(print).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Вернуться к заказу" })).toBeDefined();
});

it("says the template is missing when the id in the link no longer resolves", async () => {
  const { container, print } = renderPrintPage({ template: TEMPLATE.stock, templateFails: true });

  expect(await screen.findByText("Нет шаблона этикетки для этих кодов")).toBeDefined();
  expect(pages(container)).toHaveLength(0);
  expect(print).not.toHaveBeenCalled();
});

it("does not print a sheet for an issue that holds no codes", async () => {
  const { container, print } = renderPrintPage({ template: TEMPLATE.stock, codes: [] });

  expect(await screen.findByText("В этой выдаче нет кодов")).toBeDefined();
  expect(pages(container)).toHaveLength(0);
  expect(print).not.toHaveBeenCalled();
});

it("reports a failed code read without printing an empty sheet", async () => {
  const { container, print } = renderPrintPage({ template: TEMPLATE.stock, codesFail: true });

  expect(await screen.findByText("Не удалось загрузить коды для печати")).toBeDefined();
  expect(pages(container)).toHaveLength(0);
  expect(print).not.toHaveBeenCalled();
});

// -- the guard chain ------------------------------------------------------
// The route sits outside the application shell but inside the auth and
// access gate: a page of live marking codes must not render for a visitor
// the cabinet has not authorised.

const ACTIVE_SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};
const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-co" }];

function fakeAuthClient(session: SessionData | null): AuthClientLike {
  return {
    useSession: () => ({ data: session, isPending: false, error: null }),
    useListOrganizations: () => ({ data: ORGANIZATIONS, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: async () => ({ data: {}, error: null }),
    organization: {
      create: async () => ({ data: { id: "org_1" }, error: null }),
      list: async () => ({ data: ORGANIZATIONS, error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
  };
}

function renderGuardedRoute(
  session: SessionData | null,
  access: AccessDocument,
  options: { batch?: boolean } = {},
) {
  const urls: string[] = [];
  const orderUrl = `/api/chz-km-orders/${ID.order}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/api/profile")) {
        return jsonResponse({
          firstName: "Елена",
          lastName: "Ким",
          middleName: null,
          hasAvatar: false,
        });
      }
      if (url.endsWith("/api/access/me")) return jsonResponse(access);
      if (options.batch === true) {
        if (url === orderUrl) return jsonResponse(order());
        if (url === `${orderUrl}/issues/${ID.issue}/codes`) return jsonResponse({ codes: CODES });
        if (url.startsWith("/api/label-templates/")) return jsonResponse(full());
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  vi.stubGlobal("print", vi.fn());

  const router = createMemoryRouter(appRoutes, {
    initialEntries: [`/km-orders/${ID.order}/issues/${ID.issue}/print?template=${TEMPLATE.stock}`],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={fakeAuthClient(session)}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { router, urls, container };
}

it("sends a visitor without a session to the login page instead of the codes", async () => {
  const { router, urls } = renderGuardedRoute(null, ACCESS_WRITE);

  await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  expect(urls.some((url) => url.includes("/codes"))).toBe(false);
});

it("refuses the page to a grant that may not hand codes to the floor", async () => {
  const { urls } = renderGuardedRoute(ACTIVE_SESSION, ACCESS_READ_ONLY);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(urls.some((url) => url.includes("/codes"))).toBe(false);
});

it("renders the sheet outside the application shell", async () => {
  // The whole reason the route is split out of `ShellPage`: a sidebar on a
  // page of physical labels would be printed. Both guard tests above pass
  // just as well with the route nested inside the shell, so this is the
  // assertion that holds the split in place.
  const { container } = renderGuardedRoute(ACTIVE_SESSION, ACCESS_WRITE, { batch: true });

  await waitFor(() => expect(pages(container)).toHaveLength(3));

  expect(screen.queryByRole("navigation")).toBeNull();
  expect(container.querySelector("nav")).toBeNull();
  expect(container.querySelector(".mk-sidebar")).toBeNull();
});
