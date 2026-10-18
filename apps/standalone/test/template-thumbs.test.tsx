import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDuplicateLabelTemplate, type LabelTemplateSpec } from "@markiro/domain";

import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { readSpec } from "../src/office/templates/editor-model.js";
import {
  drawLabel,
  paintCodeRasters,
  type LabelCanvas,
} from "../src/office/templates/label-renderer.js";
import {
  BROWSER_LABEL_RENDERING,
  LabelRenderingProvider,
  type LabelRendering,
} from "../src/office/templates/label-rendering.js";
import { labelSampleData } from "../src/office/templates/label-samples.js";
import { TemplatesPage } from "../src/office/templates/TemplatesPage.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  type FakeOfficeSession,
} from "./support/office.js";

type Op = (string | number)[];

/** A 2D context that records the filled text and rectangles; a character measures 10 px. */
function recordingCanvas(): LabelCanvas & { ops: Op[] } {
  const ops: Op[] = [];
  return {
    ops,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    clearRect(x, y, w, h) {
      ops.push(["clearRect", x, y, w, h]);
    },
    fillRect() {
      ops.push(["fillRect", String(this.fillStyle)]);
    },
    strokeRect: () => undefined,
    fillText(text) {
      ops.push(["fillText", text]);
    },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  };
}

/** Rows come on screen when the test says so. */
function screenRows() {
  const watched = new Map<Element, () => void>();
  const whenVisible = (element: Element, onVisible: () => void) => {
    watched.set(element, onVisible);
    return () => {
      watched.delete(element);
    };
  };
  const show = (name: string) => {
    const row = screen.getByText(name).closest("tr");
    for (const [element, onVisible] of [...watched]) {
      if (row?.contains(element)) act(onVisible);
    }
  };
  return { whenVisible, show, watching: () => watched.size };
}

function drawingTools() {
  const canvas = recordingCanvas();
  const rows = screenRows();
  const tools: LabelRendering = {
    ...quietLabelRendering(),
    context: () => canvas,
    whenVisible: rows.whenVisible,
  };
  return { canvas, tools, show: rows.show, watching: rows.watching };
}

const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];

const MILK: LabelTemplateSummary = {
  id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  name: "Молоко 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: false,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 60,
};

const PALLET: LabelTemplateSummary = {
  ...MILK,
  id: "0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f",
  name: "Паллета 100×150",
  purpose: "pallet",
  widthMm: 100,
  heightMm: 150,
};

const MILK_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "field", id: "name", xMm: 4, yMm: 4, field: "product.printName", fontSizePt: 10 },
  ],
};

function layoutOf(
  summary: LabelTemplateSummary,
  spec: LabelTemplate["spec"] = MILK_SPEC,
): LabelTemplate {
  return {
    id: summary.id,
    name: summary.name,
    purpose: summary.purpose,
    enabled: summary.enabled,
    chzProductGroupCodes: summary.chzProductGroupCodes,
    stock: summary.stock,
    spec,
    rev: summary.rev,
  };
}

function session(templates: LabelTemplateSummary[] = [MILK, PALLET]): FakeOfficeSession {
  // The administrator: «Профиль», where a test leaves the list for a while, is theirs.
  const fake = fakeOfficeSession();
  fake.api.listTemplates.mockResolvedValue(templates);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  return fake;
}

async function openTemplates(): Promise<void> {
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function thumbOf(name: string): HTMLElement {
  const thumb = screen.getByText(name).closest("tr")?.querySelector(".template-thumb");
  if (!(thumb instanceof HTMLElement)) throw new Error(`no thumbnail for ${name}`);
  return thumb;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the templates' thumbnails", () => {
  it("reads a row's layout once the row is on screen, and draws it with the purpose's sample", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    expect(fake.api.getTemplate).not.toHaveBeenCalled();
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
    show("Молоко 58×40");
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
    expect(fake.api.getTemplate).toHaveBeenCalledWith("office-session-token", MILK.id);
    // 58 × 40 mm inside 64 × 48 px: the width fills the box.
    const label = thumbOf("Молоко 58×40").querySelector("canvas");
    expect(label?.getAttribute("width")).toBe("64");
    expect(label?.getAttribute("height")).toBe("44");
    expect(canvas.ops).toContainEqual(["fillText", "Пиво светлое"]);
    expect(thumbOf("Паллета 100×150").querySelector("canvas")).toBeNull();
  });

  it("paints a product duplicate's code as the station's raster", async () => {
    const duplicate: LabelTemplateSummary = {
      ...MILK,
      name: "Дубликат 58×40",
      purpose: "product_duplicate",
    };
    const fake = session([duplicate]);
    fake.api.getTemplate.mockResolvedValue(layoutOf(duplicate, buildDuplicateLabelTemplate()));
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Дубликат 58×40");
    await waitFor(() =>
      expect(
        canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000").length,
      ).toBeGreaterThan(50),
    );
  });

  it("keeps a layout by id and revision: the same revision is not read again, a new one is", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Молоко 58×40");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    await openTemplates();
    // Drawn again from what was read, before the row is even on screen.
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    show("Молоко 58×40");
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
    fake.api.listTemplates.mockResolvedValue([{ ...MILK, rev: 61 }, PALLET]);
    fake.api.getTemplate.mockResolvedValue(layoutOf({ ...MILK, rev: 61 }));
    fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    await openTemplates();
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
    show("Молоко 58×40");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(2));
  });

  it("leaves an empty frame for a layout that does not load or does not read", async () => {
    const fake = session();
    fake.api.getTemplate.mockImplementation(async (_token: string, id: string) => {
      if (id === MILK.id) throw new Error("down");
      return layoutOf(PALLET, { widthMm: 100 });
    });
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Молоко 58×40");
    show("Паллета 100×150");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
    expect(thumbOf("Паллета 100×150").querySelector("canvas")).toBeNull();
    expect(canvas.ops).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is a picture beside the name that assistive technology skips", async () => {
    const fake = session();
    const { tools } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    const thumb = thumbOf("Молоко 58×40");
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect(thumb.parentElement?.classList.contains("template-name")).toBe(true);
    expect(thumb.nextElementSibling?.textContent).toBe("Молоко 58×40");
    const row = screen.getByText("Молоко 58×40").closest("tr");
    if (row === null) throw new Error("no row");
    expect(within(row).queryByRole("img")).toBeNull();
  });

  it("keeps the layouts out of the list's cache, each under its id and revision", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show } = drawingTools();
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <LabelRenderingProvider value={tools}>
            <MemoryRouter>
              <TemplatesPage />
            </MemoryRouter>
          </LabelRenderingProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Молоко 58×40");
    show("Молоко 58×40");
    await waitFor(() =>
      expect(queryClient.getQueryData(officeKeys.templateLayout(MILK.id, 60))).toStrictEqual(
        layoutOf(MILK),
      ),
    );
    expect(queryClient.getQueryData(officeKeys.templates)).toStrictEqual([MILK, PALLET]);
  });
});

const SEARCH = "Поиск";

describe("the thumbnails' extra guards", () => {
  it("watches a row until it is on screen and stops once it has come", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show, watching } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    expect(watching()).toBe(2);
    show("Молоко 58×40");
    // One watcher gone, none added again for the row that came.
    expect(watching()).toBe(1);
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    expect(watching()).toBe(1);
    show("Паллета 100×150");
    expect(watching()).toBe(0);
  });

  it("stops watching the rows that leave: with the search, and with the page", async () => {
    const fake = session();
    const { tools, watching } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    expect(watching()).toBe(2);
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "Паллета" } });
    await waitFor(() => expect(screen.queryByText("Молоко 58×40")).toBeNull());
    expect(watching()).toBe(1);
    fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    expect(watching()).toBe(0);
  });

  it("reads only the rows that come on screen, each under its own id, among many", async () => {
    const many: LabelTemplateSummary[] = Array.from({ length: 24 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        ...MILK,
        id: `00000000-0000-4000-8000-0000000000${number}`,
        name: `Шаблон ${number}`,
      };
    });
    const fake = session(many);
    fake.api.getTemplate.mockImplementation(async (_token: string, id: string) => {
      const summary = many.find((template) => template.id === id);
      if (summary === undefined) throw new Error("unknown template");
      return layoutOf(summary);
    });
    const { tools, show, watching } = drawingTools();
    // The list shows ten rows to a page; all 24 are on one page of a hundred.
    localStorage.setItem("markiro.office.pageSize.templates", "100");
    renderOffice(fake, { labels: tools });
    await openTemplates();
    expect(watching()).toBe(24);
    expect(fake.api.getTemplate).not.toHaveBeenCalled();
    show("Шаблон 03");
    show("Шаблон 17");
    show("Шаблон 24");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      for (const name of ["Шаблон 03", "Шаблон 17", "Шаблон 24"]) {
        expect(thumbOf(name).querySelector("canvas")).not.toBeNull();
      }
    });
    expect(fake.api.getTemplate.mock.calls.map(([, id]) => id).sort()).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000017",
      "00000000-0000-4000-8000-000000000024",
    ]);
    expect(thumbOf("Шаблон 04").querySelector("canvas")).toBeNull();
  });

  it("watches only the rows of the page that is shown", async () => {
    const many: LabelTemplateSummary[] = Array.from({ length: 24 }, (_, index) => ({
      ...MILK,
      id: `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, "0")}`,
      name: `Шаблон ${String(index + 1).padStart(2, "0")}`,
    }));
    const { tools, watching } = drawingTools();
    renderOffice(session(many), { labels: tools });
    await openTemplates();
    expect(watching()).toBe(10);
  });

  it("fits the label into the box by the tighter side, and draws it at that scale with its purpose's sample", async () => {
    const fake = session();
    fake.api.getTemplate.mockImplementation(async (_token: string, id: string) =>
      id === MILK.id
        ? layoutOf(MILK)
        : layoutOf(PALLET, {
            widthMm: 100,
            heightMm: 150,
            dpi: 203,
            language: "zpl",
            elements: [{ kind: "field", id: "qty", xMm: 4, yMm: 4, field: "qty", fontSizePt: 10 }],
          }),
    );
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Паллета 100×150");
    await waitFor(() => expect(thumbOf("Паллета 100×150").querySelector("canvas")).not.toBeNull());
    // 100 × 150 mm inside 64 × 48 px: the height fills the box.
    const pallet = thumbOf("Паллета 100×150").querySelector("canvas");
    expect(pallet?.getAttribute("width")).toBe("32");
    expect(pallet?.getAttribute("height")).toBe("48");
    const cleared = canvas.ops.find((op) => op[0] === "clearRect");
    expect(cleared?.[1]).toBe(0);
    expect(cleared?.[2]).toBe(0);
    expect(cleared?.[3]).toBeCloseTo(32, 6);
    expect(cleared?.[4]).toBeCloseTo(48, 6);
    // The pallet's sample (240 units), not the box's.
    expect(canvas.ops.filter((op) => op[0] === "fillText").map((op) => op[1])).toEqual(["240 шт."]);
    canvas.ops.length = 0;
    show("Молоко 58×40");
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    const milk = canvas.ops.find((op) => op[0] === "clearRect");
    expect(milk?.[3]).toBeCloseTo((58 * 64) / 58, 6);
    expect(milk?.[4]).toBeCloseTo((40 * 64) / 58, 6);
  });

  it("keeps a layout drawn while its row leaves the list with the search and comes back", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Молоко 58×40");
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "Паллета" } });
    await waitFor(() => expect(screen.queryByText("Молоко 58×40")).toBeNull());
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: "" } });
    // Back before it is on screen: drawn from what was read, and not read again.
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    show("Молоко 58×40");
    await act(async () => {});
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
  });

  it("puts the layout under the key the plan names and leaves the summaries as the host sent them", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show } = drawingTools();
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <LabelRenderingProvider value={tools}>
            <MemoryRouter>
              <TemplatesPage />
            </MemoryRouter>
          </LabelRenderingProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Молоко 58×40");
    expect(officeKeys.templateLayout(MILK.id, 60)).toEqual([
      "office",
      "template-layout",
      MILK.id,
      60,
    ]);
    show("Молоко 58×40");
    await waitFor(() =>
      expect(queryClient.getQueryData(["office", "template-layout", MILK.id, 60])).toStrictEqual(
        layoutOf(MILK),
      ),
    );
    // Nothing is under the editor's key for the template or the list's.
    expect(queryClient.getQueryData(officeKeys.template(MILK.id))).toBeUndefined();
    const summaries = queryClient.getQueryData<LabelTemplateSummary[]>(officeKeys.templates);
    for (const summary of summaries ?? []) {
      expect(Object.keys(summary)).not.toContain("spec");
    }
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .filter(
          (query) => query.queryKey[1] === "template-layout" && query.state.data !== undefined,
        ),
    ).toHaveLength(1);
  });

  it("shows no name, no label and no text of its own, for a stock and a disabled row with markup in its name", async () => {
    const markup = `<img src="x" onerror="alert(1)"> & "q" <b>x</b>`;
    const odd: LabelTemplateSummary = {
      ...MILK,
      name: markup,
      stock: true,
      enabled: false,
    };
    const fake = session([odd]);
    fake.api.getTemplate.mockResolvedValue(layoutOf(odd));
    const { tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show(markup);
    await waitFor(() => expect(thumbOf(markup).querySelector("canvas")).not.toBeNull());
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
    const row = screen.getByText(markup).closest("tr");
    if (row === null) throw new Error("no row");
    const text = row.querySelector(".template-name__text");
    expect(text?.textContent).toBe(markup);
    expect(text?.children).toHaveLength(0);
    expect(row.querySelector("img, b")).toBeNull();
    const thumb = thumbOf(markup);
    expect(thumb.getAttributeNames().sort()).toEqual(["aria-hidden", "class"]);
    expect(thumb.textContent).toBe("");
    expect(thumb.querySelector("canvas")?.getAttributeNames().sort()).toEqual([
      "class",
      "height",
      "width",
    ]);
    expect(within(row).getAllByText("Типовой")).toHaveLength(1);
    // The name is said once: by the text, not by the picture.
    expect(within(row).queryAllByText(markup)).toHaveLength(1);
    expect(within(row).queryByLabelText(markup)).toBeNull();
    expect(within(row).queryByTitle(markup)).toBeNull();
    expect(row.querySelectorAll("[alt]")).toHaveLength(0);
  });

  it("draws a product duplicate op for op as the station's raster at the thumbnail's scale", async () => {
    const duplicate: LabelTemplateSummary = {
      ...MILK,
      name: "Дубликат 58×40",
      purpose: "product_duplicate",
    };
    const spec = readSpec(buildDuplicateLabelTemplate());
    if (spec === null) throw new Error("the duplicate's layout does not read");
    const fake = session([duplicate]);
    fake.api.getTemplate.mockResolvedValue(layoutOf(duplicate, buildDuplicateLabelTemplate()));
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Дубликат 58×40");
    // The reference: the layout as the editor draws a duplicate, with the options spelled out.
    const reference = recordingCanvas();
    const scale = Math.min(64 / spec.widthMm, 48 / spec.heightMm);
    const data = labelSampleData("product_duplicate");
    drawLabel(spec, reference, scale, data, { kmDataMatrix: "raster" });
    await paintCodeRasters(spec, reference, scale, data, { kmDataMatrix: "raster" }, () => false);
    expect(reference.ops.length).toBeGreaterThan(50);
    await waitFor(() => expect(canvas.ops).toEqual(reference.ops));
  });

  it("does not paint a duplicate's code after its row has gone", async () => {
    const duplicate: LabelTemplateSummary = {
      ...MILK,
      name: "Дубликат 58×40",
      purpose: "product_duplicate",
    };
    const fake = session([duplicate]);
    fake.api.getTemplate.mockResolvedValue(layoutOf(duplicate, buildDuplicateLabelTemplate()));
    const { canvas, tools, show } = drawingTools();
    const view = renderOffice(fake, { labels: tools });
    await openTemplates();
    // The page goes away right after the layout is drawn, while the print code
    // is still on its way.
    const drawn = canvas.clearRect.bind(canvas);
    canvas.clearRect = (x, y, width, height) => {
      drawn(x, y, width, height);
      queueMicrotask(() => view.unmount());
    };
    show("Дубликат 58×40");
    await waitFor(() => expect(canvas.ops.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText("Дубликат 58×40")).toBeNull());
    // The same import the thumbnail awaits, then a turn of the event loop: whatever
    // the thumbnail does with the print code has been done by now.
    await act(async () => {
      await import("../src/office/templates/label-print.js");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000")).toEqual([]);
  });
});

describe("the webview's way to tell a thumbnail is on screen", () => {
  /** An observer that only records what the page asks of it. */
  class FakeObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin: string;
    readonly scrollMargin = "0px";
    readonly thresholds: readonly number[] = [0];
    readonly observed: Element[] = [];
    disconnected = 0;

    constructor(
      readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.rootMargin = options?.rootMargin ?? "0px";
    }

    observe(element: Element) {
      this.observed.push(element);
    }

    unobserve() {
      return undefined;
    }

    disconnect() {
      this.disconnected += 1;
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  function stubObserver(): FakeObserver[] {
    const made: FakeObserver[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class extends FakeObserver {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          super(callback, options);
          made.push(this);
        }
      },
    );
    return made;
  }

  /** A full entry for `target`, as the browser makes one. */
  function entry(isIntersecting: boolean, target: Element): IntersectionObserverEntry {
    const box = target.getBoundingClientRect();
    return {
      target,
      time: 0,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: box,
      intersectionRect: box,
      rootBounds: null,
      isIntersecting,
    };
  }

  it("shows a thumbnail at once where the webview has no observer", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onVisible = vi.fn();
    const stop = BROWSER_LABEL_RENDERING.whenVisible(document.createElement("span"), onVisible);
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it("watches the element 200 px ahead, ignores what is not on screen and tells once when it is", () => {
    const made = stubObserver();
    const element = document.createElement("span");
    const onVisible = vi.fn();
    BROWSER_LABEL_RENDERING.whenVisible(element, onVisible);
    expect(made).toHaveLength(1);
    const [watcher] = made;
    if (watcher === undefined) throw new Error("no observer");
    expect(watcher.rootMargin).toBe("200px");
    expect(watcher.observed).toEqual([element]);
    expect(onVisible).not.toHaveBeenCalled();
    watcher.callback([], watcher);
    watcher.callback([entry(false, element)], watcher);
    expect(onVisible).not.toHaveBeenCalled();
    expect(watcher.disconnected).toBe(0);
    watcher.callback([entry(false, element), entry(true, element)], watcher);
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(watcher.disconnected).toBe(1);
  });

  it("reads every row at once, quietly, in a webview without an observer", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fake = session();
    fake.api.getTemplate.mockRejectedValue(new Error("down"));
    renderOffice(fake, {
      labels: { ...quietLabelRendering(), whenVisible: BROWSER_LABEL_RENDERING.whenVisible },
    });
    await openTemplates();
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
  });

  it("stops watching on request", () => {
    const made = stubObserver();
    const stop = BROWSER_LABEL_RENDERING.whenVisible(document.createElement("span"), vi.fn());
    stop();
    expect(made[0]?.disconnected).toBe(1);
  });
});
