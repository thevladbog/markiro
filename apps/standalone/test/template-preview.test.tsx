import { readFile } from "node:fs/promises";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDuplicateLabelTemplate,
  type LabelTemplateSpec,
  type RasterizeTextOptions,
  type RasterResult,
} from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { FONT_SUBSET_URLS, type LabelFontFamily } from "../src/labels/font-coverage.js";
import { RasterUnavailableError } from "../src/labels/rasterizer.js";
import { Office } from "../src/office/Office.js";
import type { LabelCanvas } from "../src/office/templates/label-renderer.js";
import {
  BROWSER_LABEL_RENDERING,
  forgetFontCoverageAnswers,
  LabelRenderingProvider,
  type LabelRendering,
} from "../src/office/templates/label-rendering.js";
import { PreviewPane } from "../src/office/templates/PreviewPane.js";
import {
  fakeOfficeSession,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
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
    fillRect(x, y, w, h) {
      ops.push(["fillRect", String(this.fillStyle), x, y, w, h]);
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

const DOT: RasterResult = { hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 };

/** Rendering that draws on a recording canvas; the rasterizer and the check are the test's. */
function drawingTools(overrides: Partial<LabelRendering> = {}) {
  const canvas = recordingCanvas();
  const tools: LabelRendering = {
    ...quietLabelRendering(),
    context: () => canvas,
    ...overrides,
  };
  return { canvas, tools };
}

const ASCII: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "text", id: "lot", xMm: 4, yMm: 4, text: "LOT", fontSizePt: 10 },
    { kind: "field", id: "gtin", xMm: 4, yMm: 12, field: "product.gtin", fontSizePt: 10 },
  ],
};

const CYRILLIC: LabelTemplateSpec = {
  ...ASCII,
  widthMm: 100,
  elements: [{ kind: "text", id: "batch", xMm: 4, yMm: 20, text: "Партия", fontSizePt: 9 }],
};

const OTHER_CYRILLIC: LabelTemplateSpec = {
  ...CYRILLIC,
  elements: [{ kind: "text", id: "shift", xMm: 4, yMm: 20, text: "Смена", fontSizePt: 9 }],
};

/** Makes every `<canvas>` of the page give `canvas` as its 2D context; returns the restore. */
function installWebviewCanvas(canvas: LabelCanvas, kinds: string[] = []): () => void {
  const real = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (real === undefined) throw new Error("test/setup.ts defines no canvas getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: (kind: string) => {
      kinds.push(kind);
      return canvas;
    },
  });
  return () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", real);
  };
}

function preview(
  spec: LabelTemplateSpec,
  tools: LabelRendering,
  purpose: "box" | "product_duplicate" = "box",
) {
  return (
    <LabelRenderingProvider value={tools}>
      <PreviewPane spec={spec} purpose={purpose} />
    </LabelRenderingProvider>
  );
}

const MISSING =
  "В шрифте этикетки нет кириллицы: русский текст напечатается не так, как в предпросмотре. Переустановите приложение на этом ПК.";
const CHECK_FAILED =
  "Не удалось проверить шрифт этикетки: русский текст может напечататься не так, как в предпросмотре.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the layout preview", () => {
  it("draws the layout with the purpose's sample at 3 px per millimetre, as an image named by its size", () => {
    const { canvas, tools } = drawingTools();
    render(preview(ASCII, tools));
    const image = screen.getByRole("img", { name: "Предпросмотр этикетки 58 × 40 мм" });
    expect(image.getAttribute("width")).toBe("174");
    expect(image.getAttribute("height")).toBe("120");
    expect(canvas.ops[0]).toEqual(["clearRect", 0, 0, 174, 120]);
    expect(canvas.ops).toContainEqual(["fillText", "LOT"]);
    expect(canvas.ops).toContainEqual(["fillText", "04600682000013"]);
    expect(
      screen.getByText("Русский текст показан растром печати, коды — схемой. Масштаб: 3 пикс./мм."),
    ).toBeTruthy();
  });

  it("draws again when the layout changes, with the print bitmaps over its Cyrillic text", async () => {
    const rasterize = vi.fn(async (_text: string, _options: RasterizeTextOptions) => DOT);
    const { canvas, tools } = drawingTools({ rasterizeText: rasterize });
    const view = render(preview(ASCII, tools));
    expect(rasterize).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(preview(CYRILLIC, tools));
    });
    expect(screen.getByRole("img", { name: "Предпросмотр этикетки 100 × 40 мм" })).toBeTruthy();
    expect(rasterize.mock.calls.map(([text]) => text)).toEqual(["Партия"]);
    expect(canvas.ops).toContainEqual(["clearRect", 0, 0, 300, 120]);
    expect(canvas.ops.at(-1)?.[1]).toBe("#000000");
  });

  it("paints no bitmap of a layout that changed while it was being made", async () => {
    let finish: (raster: RasterResult) => void = () => undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<RasterResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { canvas, tools } = drawingTools({ rasterizeText: rasterize });
    const view = render(preview(CYRILLIC, tools));
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
    view.rerender(preview(ASCII, tools));
    const drawn = canvas.ops.length;
    await act(async () => {
      finish(DOT);
    });
    expect(canvas.ops).toHaveLength(drawn);
  });

  it("checks the font only for Cyrillic text, and says when it lacks Cyrillic or could not be checked", async () => {
    let answer: (covered: boolean) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const check = vi
      .fn<(family: LabelFontFamily) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            fail = reject;
          }),
      );
    const { tools } = drawingTools({ checkFamilyCoverage: check });
    const view = render(preview(ASCII, tools));
    expect(check).not.toHaveBeenCalled();
    view.rerender(preview(CYRILLIC, tools));
    expect(check).toHaveBeenCalledWith("IBM Plex Sans");
    await act(async () => {
      answer(false);
    });
    expect(screen.getByRole("alert").textContent).toContain(MISSING);
    // A layout without such text has nothing to warn about.
    view.rerender(preview(ASCII, tools));
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(preview(CYRILLIC, tools));
    await act(async () => {
      fail(new Error("no font file"));
    });
    expect(screen.getByRole("alert").textContent).toContain(CHECK_FAILED);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("shows no warning of an earlier check for a layout whose own check has not answered", async () => {
    const pending: ((covered: boolean) => void)[] = [];
    const check = vi.fn(
      (_family: LabelFontFamily) =>
        new Promise<boolean>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { tools } = drawingTools({ checkFamilyCoverage: check });
    const view = render(preview(CYRILLIC, tools));
    await act(async () => {
      pending[0]?.(false);
    });
    expect(screen.getByRole("alert").textContent).toContain(MISSING);
    // Another Cyrillic text is the same check: its answer still stands.
    view.rerender(preview(OTHER_CYRILLIC, tools));
    expect(screen.getByRole("alert").textContent).toContain(MISSING);
    expect(check).toHaveBeenCalledTimes(1);
    view.rerender(preview(ASCII, tools));
    view.rerender(preview(CYRILLIC, tools));
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      pending[1]?.(false);
    });
    expect(screen.getByRole("alert").textContent).toContain(MISSING);
  });

  it("says nothing about the font when it has Cyrillic", async () => {
    const { tools } = drawingTools({ checkFamilyCoverage: async () => true });
    render(preview(CYRILLIC, tools));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("paints a product duplicate's code as the station's raster once its encoder has loaded", async () => {
    const { canvas, tools } = drawingTools();
    render(preview(buildDuplicateLabelTemplate(), tools, "product_duplicate"));
    const ink = () => canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000");
    expect(ink()).toEqual([]);
    await waitFor(() => expect(ink().length).toBeGreaterThan(50));
  });

  it("tells that a product duplicate's code is a synthetic sample", () => {
    const { tools } = drawingTools();
    const view = render(preview(ASCII, tools, "product_duplicate"));
    const sample = "Образец с синтетическим кодом. На линии печатается код со сканера.";
    expect(screen.getByText(sample)).toBeTruthy();
    view.rerender(preview(ASCII, tools));
    expect(screen.queryByText(sample)).toBeNull();
  });
});

describe("the layout preview, beyond the plan", () => {
  const ink = (canvas: { ops: Op[] }) =>
    canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000");

  it("shows a layout's text only as drawn text, never as markup", () => {
    const raw = '<img src=x onerror="alert(1)"> &amp; <b>Партия</b>';
    const spec: LabelTemplateSpec = {
      ...ASCII,
      elements: [{ kind: "text", id: "raw", xMm: 4, yMm: 4, text: raw, fontSizePt: 10 }],
    };
    const { canvas, tools } = drawingTools();
    const view = render(preview(spec, tools));
    expect(canvas.ops).toContainEqual(["fillText", raw]);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("b")).toBeNull();
    expect(view.container.innerHTML).not.toContain("onerror");
  });

  it("draws again when only the purpose, the context or the rasterizer changes", async () => {
    const first = drawingTools();
    const view = render(preview(ASCII, first.tools));
    expect(first.canvas.ops).not.toContainEqual(["fillText", "04600000000015"]);
    view.rerender(preview(ASCII, first.tools, "product_duplicate"));
    expect(first.canvas.ops).toContainEqual(["fillText", "04600000000015"]);
    const second = drawingTools();
    view.rerender(preview(ASCII, second.tools, "product_duplicate"));
    expect(second.canvas.ops).toContainEqual(["fillText", "04600000000015"]);
    const rasterize = vi.fn(async (_text: string, _options: RasterizeTextOptions) => DOT);
    const third = drawingTools({ rasterizeText: rasterize });
    view.rerender(preview(CYRILLIC, third.tools));
    await act(async () => {});
    expect(rasterize).toHaveBeenCalledTimes(1);
    const later = vi.fn(async (_text: string, _options: RasterizeTextOptions) => DOT);
    view.rerender(preview(CYRILLIC, { ...third.tools, rasterizeText: later }));
    await act(async () => {});
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("lets a slow bitmap of an older layout not paint over the newer one", async () => {
    const finishers: ((raster: RasterResult) => void)[] = [];
    const rasterize = vi.fn(
      () =>
        new Promise<RasterResult>((resolve) => {
          finishers.push(resolve);
        }),
    );
    const { canvas, tools } = drawingTools({ rasterizeText: rasterize });
    const view = render(preview(CYRILLIC, tools));
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
    view.rerender(preview(OTHER_CYRILLIC, tools));
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishers[1]?.(DOT);
    });
    const drawn = canvas.ops.length;
    expect(canvas.ops.at(-1)?.[1]).toBe("#000000");
    await act(async () => {
      finishers[0]?.(DOT);
    });
    expect(canvas.ops).toHaveLength(drawn);
  });

  it("paints no bitmap once the preview is gone", async () => {
    let finish: (raster: RasterResult) => void = () => undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<RasterResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { canvas, tools } = drawingTools({ rasterizeText: rasterize });
    const view = render(preview(CYRILLIC, tools));
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
    view.unmount();
    const drawn = canvas.ops.length;
    await act(async () => {
      finish(DOT);
    });
    expect(canvas.ops).toHaveLength(drawn);
  });

  it("paints no duplicate code of a layout that changed while its encoder was loading", async () => {
    const { canvas, tools } = drawingTools();
    const view = render(preview(buildDuplicateLabelTemplate(), tools, "product_duplicate"));
    view.rerender(preview(ASCII, tools));
    await act(async () => {
      await import("../src/office/templates/label-print.js");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ink(canvas)).toEqual([]);
  });

  it("checks the font once while the layout keeps its Cyrillic text, and drops an answer nobody waits for", async () => {
    const pending: { resolve: (covered: boolean) => void; reject: (error: Error) => void }[] = [];
    const check = vi.fn(
      (_family: LabelFontFamily) =>
        new Promise<boolean>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const { tools } = drawingTools({ checkFamilyCoverage: check });
    const view = render(preview(CYRILLIC, tools));
    view.rerender(preview(OTHER_CYRILLIC, tools));
    expect(check).toHaveBeenCalledTimes(1);
    // The layout loses its Cyrillic text: the answer that arrives now is nobody's.
    view.rerender(preview(ASCII, tools));
    await act(async () => {
      pending[0]?.resolve(false);
    });
    view.rerender(preview(CYRILLIC, tools));
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(preview(ASCII, tools));
    await act(async () => {
      pending[1]?.reject(new Error("late"));
    });
    view.rerender(preview(CYRILLIC, tools));
    expect(check).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the office's own way of drawing labels", () => {
  it("draws on the webview's 2D canvas when no tools are given", () => {
    const canvas = recordingCanvas();
    const kinds: string[] = [];
    const restore = installWebviewCanvas(canvas, kinds);
    try {
      render(<PreviewPane spec={ASCII} purpose="box" />);
    } finally {
      restore();
    }
    expect(kinds).toEqual(["2d"]);
    expect(canvas.ops).toContainEqual(["fillText", "LOT"]);
  });

  it("gives the office the webview's canvas unless a test passes its own", async () => {
    const canvas = recordingCanvas();
    const fake = fakeOfficeSession({ user: TECHNOLOGIST });
    fake.api.listTemplates.mockResolvedValue([]);
    fake.api.listProductGroups.mockResolvedValue([]);
    const restore = installWebviewCanvas(canvas);
    try {
      render(
        <ThemeProvider defaultTheme="dark">
          <Office session={fake} />
        </ThemeProvider>,
      );
      fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
      await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
      await screen.findByRole("heading", { name: "Новый шаблон" });
    } finally {
      restore();
    }
    expect(canvas.ops[0]).toEqual(["clearRect", 0, 0, 174, 120]);
  });

  it("is quiet in tests: no canvas, no bitmaps, a font check that never answers", async () => {
    const quiet = quietLabelRendering();
    const restore = installWebviewCanvas(recordingCanvas());
    try {
      expect(quiet.context(document.createElement("canvas"))).toBeNull();
    } finally {
      restore();
    }
    await expect(
      quiet.rasterizeText("Партия", { fontFamily: "sans-serif", fontSizePx: 34, bold: false }),
    ).rejects.toBeInstanceOf(RasterUnavailableError);
    const settled = await Promise.race([
      quiet.checkFamilyCoverage("IBM Plex Sans"),
      Promise.resolve("silent"),
    ]);
    expect(settled).toBe("silent");
  });

  it("has a jsdom canvas that answers null without a «Not implemented» error", () => {
    // jsdom reports it on the process's stderr, not through `console`.
    const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(document.createElement("canvas").getContext("2d")).toBeNull();
    expect(written).not.toHaveBeenCalled();
  });
});

describe("the webview's font check", () => {
  /** The file behind a font's asset URL (Vite serves it as `/@fs/<absolute path>` in tests). */
  async function bundledFile(url: string): Promise<ArrayBuffer> {
    const bytes = await readFile(decodeURIComponent(url.replace(/^\/@fs/, "")));
    return new Uint8Array(bytes).buffer;
  }

  function answerFonts() {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: () => bundledFile(url),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    forgetFontCoverageAnswers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetFontCoverageAnswers();
  });

  it("reads a family's font files once, whatever the number of asks", async () => {
    const fetchMock = answerFonts();
    const { checkFamilyCoverage } = BROWSER_LABEL_RENDERING;
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      ...FONT_SUBSET_URLS["IBM Plex Sans"],
    ]);
  });

  it("keeps the answers apart by family", async () => {
    const fetchMock = answerFonts();
    const { checkFamilyCoverage } = BROWSER_LABEL_RENDERING;
    await checkFamilyCoverage("IBM Plex Sans");
    await checkFamilyCoverage("IBM Plex Mono");
    await checkFamilyCoverage("IBM Plex Mono");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      ...FONT_SUBSET_URLS["IBM Plex Sans"],
      ...FONT_SUBSET_URLS["IBM Plex Mono"],
    ]);
  });

  it("shares one check between asks made while it runs", async () => {
    const fetchMock = answerFonts();
    const { checkFamilyCoverage } = BROWSER_LABEL_RENDERING;
    const answers = await Promise.all([
      checkFamilyCoverage("IBM Plex Sans"),
      checkFamilyCoverage("IBM Plex Sans"),
    ]);
    expect(answers).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not keep a check that failed: the next ask reads the files again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no font file");
      }),
    );
    const { checkFamilyCoverage } = BROWSER_LABEL_RENDERING;
    await expect(checkFamilyCoverage("IBM Plex Sans")).rejects.toThrow("no font file");
    const fetchMock = answerFonts();
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await checkFamilyCoverage("IBM Plex Sans");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("the template editor's preview", () => {
  const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];
  const BOX_58: LabelTemplateSummary = {
    id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
    name: "Коробка 58×40",
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 60,
  };
  const ZPL = [
    "^XA",
    "^PW464",
    "^LL320",
    "^FO40,40^A0N,34,34^FDПартия^FS",
    "^FO40,100^A0N,34,34^FD{{qty}}^FS",
    "^XZ",
  ].join("\n");

  it("shows the layout being edited and draws it again after an import", async () => {
    const fake = fakeOfficeSession({ user: TECHNOLOGIST });
    fake.api.listTemplates.mockResolvedValue([BOX_58]);
    fake.api.listProductGroups.mockResolvedValue(GROUPS);
    const { canvas, tools } = drawingTools();
    renderOffice(fake, { labels: tools });
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await screen.findByRole("heading", { name: "Новый шаблон" });
    const layout = screen.getByRole("heading", { level: 2, name: "Макет" }).closest(".mk-card");
    if (!(layout instanceof HTMLElement)) throw new Error("no layout card");
    expect(
      within(layout).getByRole("img", { name: "Предпросмотр этикетки 58 × 40 мм" }),
    ).toBeTruthy();
    expect(canvas.ops).not.toContainEqual(["fillText", "Партия"]);
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
    fireEvent.change(within(dialog).getByLabelText("Код ZPL"), { target: { value: ZPL } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Заменить макет" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      within(layout).getByRole("img", { name: "Предпросмотр этикетки 58,06 × 40,04 мм" }),
    ).toBeTruthy();
    expect(canvas.ops).toContainEqual(["fillText", "Партия"]);
    expect(canvas.ops).toContainEqual(["fillText", "20 шт."]);
  });

  it("previews the layout the chosen purpose starts with, and tells a duplicate's code is a sample", async () => {
    const fake = fakeOfficeSession({ user: TECHNOLOGIST });
    fake.api.listTemplates.mockResolvedValue([BOX_58]);
    fake.api.listProductGroups.mockResolvedValue(GROUPS);
    const { tools } = drawingTools();
    renderOffice(fake, { labels: tools });
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await screen.findByRole("heading", { name: "Новый шаблон" });
    const layout = screen.getByRole("heading", { level: 2, name: "Макет" }).closest(".mk-card");
    if (!(layout instanceof HTMLElement)) throw new Error("no layout card");
    const sample = "Образец с синтетическим кодом. На линии печатается код со сканера.";
    expect(within(layout).queryByText(sample)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "product_duplicate" },
    });
    expect(within(layout).getByText(sample)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    expect(
      within(layout).getByRole("img", { name: "Предпросмотр этикетки 100 × 150 мм" }),
    ).toBeTruthy();
    expect(within(layout).queryByText(sample)).toBeNull();
  });
});
