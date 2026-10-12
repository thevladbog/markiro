import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateTspl,
  generateZpl,
  type LabelTemplateSpec,
  type MonoBitmap,
} from "@markiro/domain";

import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { startingSpec } from "../src/office/templates/editor-model.js";
import type { LabelCanvas } from "../src/office/templates/label-renderer.js";
import type { LabelRendering } from "../src/office/templates/label-rendering.js";
import { labelRenderOptions, labelSampleData } from "../src/office/templates/label-samples.js";
import { useLabelLogo } from "../src/office/use-label-logo.js";
import {
  fakeOfficeSession,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
} from "./support/office.js";

// What the label logo is, is tested with the hook (use-label-logo.test.tsx): here the
// consumers' wiring is, with the logo given.
vi.mock("../src/office/use-label-logo.js", () => ({ useLabelLogo: vi.fn() }));

/** 16 × 2 dots, ink all over: a wide logo whose scaled height is smaller than its box. */
const OWN: MonoBitmap = { width: 16, height: 2, stride: 2, pixels: new Uint8Array(4).fill(0xff) };

/** A 58 × 40 label holding only a 20 × 10 mm logo box at (2, 2): its ink is the logo's. */
const LOGO_ONLY: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      id: "logo",
      kind: "organization_logo",
      source: "organization",
      fallback: "markiro",
      xMm: 2,
      yMm: 2,
      widthMm: 20,
      heightMm: 10,
    },
  ],
};

const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];

const SUMMARY: LabelTemplateSummary = {
  id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  name: "Логотип 58×40",
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

interface Ink {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A 2D context that keeps the black rectangles it is asked to fill. */
function inkCanvas(): LabelCanvas & { ink: Ink[] } {
  const ink: Ink[] = [];
  return {
    ink,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    clearRect: () => undefined,
    fillRect(x, y, width, height) {
      if (this.fillStyle === "#000000") ink.push({ x, y, width, height });
    },
    strokeRect: () => undefined,
    fillText: () => undefined,
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  };
}

/** A logo the test changes while the page is open; `use` is the hook's stand-in. */
function logoStore(initial: MonoBitmap | null) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: MonoBitmap | null) {
      current = next;
      for (const listener of listeners) listener();
    },
    use: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => current,
      ),
  };
}

function toolsOn(canvas: LabelCanvas, overrides: Partial<LabelRendering> = {}): LabelRendering {
  return { ...quietLabelRendering(), context: () => canvas, ...overrides };
}

function layoutOf(spec: LabelTemplateSpec): LabelTemplate {
  return {
    id: SUMMARY.id,
    name: SUMMARY.name,
    purpose: SUMMARY.purpose,
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    spec,
    rev: SUMMARY.rev,
  };
}

function session() {
  const fake = fakeOfficeSession({ user: TECHNOLOGIST });
  fake.api.listTemplates.mockResolvedValue([SUMMARY]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.getTemplate.mockResolvedValue(layoutOf(LOGO_ONLY));
  return fake;
}

async function openList(): Promise<void> {
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

async function openNewPallet(): Promise<void> {
  await openList();
  fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
  await screen.findByRole("heading", { name: "Новый шаблон" });
  fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
    target: { value: "pallet" },
  });
}

/** Rows come on screen as soon as the page asks. */
function visibleAtOnce(): Partial<LabelRendering> {
  return {
    whenVisible: (_element, onVisible) => {
      const timer = setTimeout(() => act(onVisible), 0);
      return () => clearTimeout(timer);
    },
  };
}

/** The print's bitmap of any text: one byte of ink, one of none. */
function bitmaps() {
  return vi.fn(async () => ({ hex: "FF00", bytesPerRow: 2, totalBytes: 2, width: 16, height: 1 }));
}

function recordDownloads() {
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:template";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return { blobs, names };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the label logo in the office's thumbnails", () => {
  it("draws the logo inside its box at the layout's resolution, scaled to the thumbnail", async () => {
    vi.mocked(useLabelLogo).mockReturnValue(OWN);
    const canvas = inkCanvas();
    renderOffice(session(), { labels: toolsOn(canvas, visibleAtOnce()) });
    await openList();
    await waitFor(() => expect(canvas.ink.length).toBeGreaterThan(0));
    // 58 × 40 mm inside 64 × 48 px: 64 / 58 px per millimetre.
    const scale = 64 / 58;
    // 20 × 10 mm is 160 × 80 dots; 16 × 2 grows by 10 to 160 × 20, 30 dots below the box's top.
    const dotPx = (scale * 25.4) / 203;
    expect(canvas.ink).toHaveLength(20);
    for (const rect of canvas.ink) {
      expect(rect.x).toBeCloseTo(16 * dotPx, 6);
      expect(rect.width).toBeCloseTo(160 * dotPx, 6);
      expect(rect.height).toBeCloseTo(dotPx, 6);
      expect(rect.y).toBeGreaterThanOrEqual((16 + 30) * dotPx - 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual((16 + 50) * dotPx + 1e-6);
    }
  });

  it("leaves the box white when there is no logo", async () => {
    vi.mocked(useLabelLogo).mockReturnValue(null);
    const canvas = inkCanvas();
    const fake = session();
    renderOffice(fake, { labels: toolsOn(canvas, visibleAtOnce()) });
    await openList();
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(canvas.ink).toEqual([]);
  });

  it("draws again when the logo arrives after the layout", async () => {
    const store = logoStore(null);
    vi.mocked(useLabelLogo).mockImplementation(store.use);
    const canvas = inkCanvas();
    const fake = session();
    renderOffice(fake, { labels: toolsOn(canvas, visibleAtOnce()) });
    await openList();
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector(".template-thumb canvas")).not.toBeNull());
    expect(canvas.ink).toEqual([]);
    act(() => store.set(OWN));
    await waitFor(() => expect(canvas.ink).toHaveLength(20));
    // The layout was read once: the logo alone drew it again.
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
  });
});

describe("the label logo in the editor", () => {
  it("previews the logo the hook gives, and not without one", async () => {
    vi.mocked(useLabelLogo).mockReturnValue(OWN);
    const withLogo = inkCanvas();
    const first = renderOffice(session(), { labels: toolsOn(withLogo) });
    await openNewPallet();
    await waitFor(() => expect(withLogo.ink.length).toBeGreaterThan(0));
    first.unmount();

    vi.mocked(useLabelLogo).mockReturnValue(null);
    const without = inkCanvas();
    renderOffice(session(), { labels: toolsOn(without) });
    await openNewPallet();
    await act(async () => undefined);
    expect(without.ink.length).toBeLessThan(withLogo.ink.length);
  });

  it("saves the ZPL file of the layout with the logo, as the print has it", async () => {
    vi.mocked(useLabelLogo).mockReturnValue(OWN);
    const saved = recordDownloads();
    const rasterize = bitmaps();
    renderOffice(session(), { labels: { ...quietLabelRendering(), rasterizeText: rasterize } });
    await openNewPallet();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    await waitFor(() => expect(saved.names).toEqual(["label.zpl"]));
    const spec = startingSpec("pallet");
    const deps = { rasterizeText: rasterize, ...labelRenderOptions("pallet") };
    const expected = await generateZpl(spec, labelSampleData("pallet"), { ...deps, logo: OWN });
    expect(expected).not.toBe(await generateZpl(spec, labelSampleData("pallet"), deps));
    expect(await saved.blobs[0]?.text()).toBe(expected);
  });

  it("saves the TSPL file of the layout with the logo, one byte for one character", async () => {
    vi.mocked(useLabelLogo).mockReturnValue(OWN);
    const saved = recordDownloads();
    const rasterize = bitmaps();
    renderOffice(session(), { labels: { ...quietLabelRendering(), rasterizeText: rasterize } });
    await openNewPallet();
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    await waitFor(() => expect(saved.names).toEqual(["label.tspl"]));
    const spec = startingSpec("pallet");
    const deps = { rasterizeText: rasterize, ...labelRenderOptions("pallet") };
    const expected = await generateTspl(spec, labelSampleData("pallet"), { ...deps, logo: OWN });
    expect(expected).not.toBe(await generateTspl(spec, labelSampleData("pallet"), deps));
    const bytes = new Uint8Array((await saved.blobs[0]?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect([...bytes]).toEqual([...expected].map((char) => char.charCodeAt(0)));
  });

  it("saves the file without the logo when there is none", async () => {
    vi.mocked(useLabelLogo).mockReturnValue(null);
    const saved = recordDownloads();
    const rasterize = bitmaps();
    renderOffice(session(), { labels: { ...quietLabelRendering(), rasterizeText: rasterize } });
    await openNewPallet();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    await waitFor(() => expect(saved.names).toEqual(["label.zpl"]));
    const expected = await generateZpl(startingSpec("pallet"), labelSampleData("pallet"), {
      rasterizeText: rasterize,
      ...labelRenderOptions("pallet"),
    });
    expect(await saved.blobs[0]?.text()).toBe(expected);
  });
});
