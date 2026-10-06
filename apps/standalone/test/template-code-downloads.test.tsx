import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateTspl,
  generateZpl,
  type RasterizeTextOptions,
  type RasterResult,
} from "@markiro/domain";

import type { LabelTemplateSummary, ProductGroup, TemplatePurpose } from "../src/host/protocol.js";
import { latin1Bytes, tsplBlob, zplBlob } from "../src/office/templates/download.js";
import { startingSpec } from "../src/office/templates/editor-model.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import type { LabelRendering } from "../src/office/templates/label-rendering.js";
import { labelRenderOptions, labelSampleData } from "../src/office/templates/label-samples.js";
import {
  fakeOfficeSession,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
} from "./support/office.js";

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

/** 58×40 mm at 203 dpi: a text line and a `{{qty}}` field, both Cyrillic once filled. */
const ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

function importedSpec() {
  const outcome = analyzeImport({ source: ZPL, format: "zpl", dpi: 203, purpose: "box" });
  if (!outcome.ok) throw new Error("the sample does not import");
  return outcome.analysis.result.spec;
}

/** A bitmap of one byte of ink and one of none: 0xFF and 0x00 once TSPL inverts them. */
const BITMAP: RasterResult = { hex: "FF00", bytesPerRow: 2, totalBytes: 2, width: 16, height: 1 };

function bitmaps() {
  return vi.fn(async (_text: string, _options: RasterizeTextOptions) => BITMAP);
}

/** What the page saves: each blob and the name of each clicked link. */
function recordDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:template";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return { blobs, names };
}

async function openNew(labels: LabelRendering): Promise<void> {
  const fake = fakeOfficeSession({ user: TECHNOLOGIST });
  fake.api.listTemplates.mockResolvedValue([BOX_58]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  renderOffice(fake, { labels });
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
  await screen.findByRole("heading", { name: "Новый шаблон" });
}

async function importZpl(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
  const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
  fireEvent.change(within(dialog).getByLabelText("Код ZPL"), { target: { value: ZPL } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить макет" }));
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

async function bytesOf(blob: Blob | undefined): Promise<number[]> {
  if (blob === undefined) throw new Error("nothing was saved");
  return [...new Uint8Array(await blob.arrayBuffer())];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../src/office/templates/label-print.js");
});

describe("a code file of a label", () => {
  it("keeps each character a byte, where a blob of the text would write two", async () => {
    const text = `A${String.fromCharCode(0xff)}`;
    expect([...latin1Bytes(text)]).toEqual([0x41, 0xff]);
    expect(new Blob([text]).size).toBe(3);
    expect(await bytesOf(tsplBlob(text))).toEqual([0x41, 0xff]);
    expect(tsplBlob(text).type).toBe("application/octet-stream");
    expect(await bytesOf(zplBlob(text))).toEqual([0x41, 0xff]);
    expect(zplBlob(text).type).toBe("text/plain");
  });
});

describe("the template editor's code downloads", () => {
  it("saves the domain's ZPL of the layout with the purpose's sample and the print's bitmaps, under the template's name", async () => {
    const saved = recordDownloads();
    const rasterize = bitmaps();
    await openNew({ ...quietLabelRendering(), rasterizeText: rasterize });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: " Молоко 58×40 " } });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    await waitFor(() => expect(saved.names).toEqual(["Молоко-58-40.zpl"]));
    expect(rasterize.mock.calls.map(([text]) => text)).toEqual(["Партия", "20 шт."]);
    const expected = await generateZpl(importedSpec(), labelSampleData("box"), {
      rasterizeText: bitmaps(),
    });
    expect(saved.blobs[0]?.type).toBe("text/plain");
    expect(await saved.blobs[0]?.text()).toBe(expected);
  });

  it("saves the domain's TSPL with the bitmap's bytes one for one", async () => {
    const saved = recordDownloads();
    await openNew({ ...quietLabelRendering(), rasterizeText: bitmaps() });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Молоко" } });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    await waitFor(() => expect(saved.names).toEqual(["Молоко.tspl"]));
    const expected = await generateTspl(importedSpec(), labelSampleData("box"), {
      rasterizeText: bitmaps(),
    });
    const bytes = await bytesOf(saved.blobs[0]);
    expect(bytes).toEqual([...expected].map((char) => char.charCodeAt(0)));
    expect(bytes).toContain(0xff);
    expect(saved.blobs[0]?.type).toBe("application/octet-stream");
  });

  it("says the file was not made when the text cannot be drawn, and saves nothing", async () => {
    const saved = recordDownloads();
    await openNew(quietLabelRendering());
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Файл не собран: русский текст этикетки не удалось нарисовать. Попробуйте ещё раз.",
    );
    expect(saved.names).toEqual([]);
  });

  it("keeps both code downloads off while a product duplicate breaks its rule, and the JSON on", async () => {
    await openNew(quietLabelRendering());
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "product_duplicate" },
    });
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", false);
    await importZpl();
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Скачать TSPL (TSC)" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Скачать JSON" })).toHaveProperty("disabled", false);
  });

  it("keeps both code downloads off while one file is being made", async () => {
    let finish: (raster: RasterResult) => void = () => undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<RasterResult>((resolve) => {
          finish = resolve;
        }),
    );
    const saved = recordDownloads();
    await openNew({ ...quietLabelRendering(), rasterizeText: rasterize });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Скачать TSPL (TSC)" })).toHaveProperty(
      "disabled",
      true,
    );
    // Two texts, one bitmap after the other.
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
    await act(async () => {
      finish(BITMAP);
    });
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(2));
    await act(async () => {
      finish(BITMAP);
    });
    await waitFor(() => expect(saved.names).toEqual(["label.tspl"]));
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", false);
  });
});

describe("the template editor's code downloads, beyond the plan's cases", () => {
  it.each<TemplatePurpose>(["product_duplicate", "pallet"])(
    "saves the %s's own sample and render options, not the box's",
    async (purpose) => {
      const saved = recordDownloads();
      await openNew({ ...quietLabelRendering(), rasterizeText: bitmaps() });
      fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
        target: { value: purpose },
      });
      fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
      await waitFor(() => expect(saved.names).toEqual(["label.zpl"]));
      const spec = startingSpec(purpose);
      const expected = await generateZpl(spec, labelSampleData(purpose), {
        rasterizeText: bitmaps(),
        ...labelRenderOptions(purpose),
      });
      // The purpose matters: neither the box's sample nor the native code would print this.
      expect(expected).not.toBe(
        await generateZpl(spec, labelSampleData("box"), { rasterizeText: bitmaps() }),
      );
      expect(await saved.blobs[0]?.text()).toBe(expected);
    },
  );

  it.each([
    ["Скачать ZPL", "Скачать TSPL (TSC)", "label.zpl"],
    ["Скачать TSPL (TSC)", "Скачать ZPL", "label.tspl"],
  ])(
    "starts one file at a time after «%s», and marks only that button as busy",
    async (pressedName, otherName, fileName) => {
      let finish: (raster: RasterResult) => void = () => undefined;
      const rasterize = vi.fn(
        () =>
          new Promise<RasterResult>((resolve) => {
            finish = resolve;
          }),
      );
      const saved = recordDownloads();
      await openNew({ ...quietLabelRendering(), rasterizeText: rasterize });
      await importZpl();
      const pressed = screen.getByRole("button", { name: pressedName });
      const other = screen.getByRole("button", { name: otherName });
      fireEvent.click(pressed);
      expect(pressed.querySelector(".mk-spin")).not.toBeNull();
      expect(other.querySelector(".mk-spin")).toBeNull();
      // Pressed again while the file is being made: nothing starts.
      fireEvent.click(other);
      fireEvent.click(pressed);
      await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
      await act(async () => {
        finish(BITMAP);
      });
      await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(2));
      await act(async () => {
        finish(BITMAP);
      });
      await waitFor(() => expect(saved.names).toEqual([fileName]));
      expect(rasterize).toHaveBeenCalledTimes(2);
      expect(saved.blobs).toHaveLength(1);
    },
  );

  it("turns the buttons back on after a failure, and a retry saves the file and clears the notice", async () => {
    const saved = recordDownloads();
    const rasterize = vi
      .fn(async (_text: string, _options: RasterizeTextOptions) => BITMAP)
      .mockRejectedValueOnce(new Error("no font"));
    await openNew({ ...quietLabelRendering(), rasterizeText: rasterize });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", false),
    );
    expect(screen.getByRole("button", { name: "Скачать TSPL (TSC)" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(saved.names).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    await waitFor(() => expect(saved.names).toEqual(["label.tspl"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the file was not made when the generators' chunk does not load, and turns the buttons back on", async () => {
    const saved = recordDownloads();
    await openNew({ ...quietLabelRendering(), rasterizeText: bitmaps() });
    await importZpl();
    vi.doMock("../src/office/templates/label-print.js", () => {
      throw new Error("the chunk did not load");
    });
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Файл не собран");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", false),
    );
    expect(saved.names).toEqual([]);
  });

  it("names the file after the template by text only, markup and path characters dropped", async () => {
    const saved = recordDownloads();
    await openNew({ ...quietLabelRendering(), rasterizeText: bitmaps() });
    fireEvent.change(screen.getByLabelText("Название"), {
      target: { value: '<b id="x">Кега</b> ../ "50 л" & Co' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    await waitFor(() => expect(saved.names).toEqual(["b-id-x-Кега-b-50-л-Co.tspl"]));
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
